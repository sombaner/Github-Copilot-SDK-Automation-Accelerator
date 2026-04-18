import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";

type ReviewKind = "architecture" | "design" | "code" | "unit-test";
type ReviewStream = "architecture-design" | "code";

interface PullRequestMetadata {
    number?: number;
    title?: string;
    url?: string;
    base_ref?: string;
    head_ref?: string;
}

interface GithubSpace {
    name: string;
    owner: string;
    repo: string;
    ref?: string;
    review_types?: ReviewKind[];
    instructions?: string[];
    context?: string[];
    description?: string;
}

interface ChangedFile {
    path: string;
    kind: ReviewKind;
    status?: string;
}

interface PromptConfig {
    review_types?: ReviewKind[];
    pull_request?: PullRequestMetadata;
    github_spaces?: GithubSpace[];
    changed_files?: Array<ChangedFile | string>;
    instructions?: string[];
}

interface ParsedPrompt {
    markdown: string;
    config: PromptConfig;
    changedFiles: ChangedFile[];
    githubSpaces: GithubSpace[];
}

interface ReviewTask {
    id: ReviewStream;
    title: string;
    model: string;
    reviewTypes: ReviewKind[];
    files: ChangedFile[];
}

type TaskSessionMap = Partial<Record<ReviewStream, string>>;

interface ReviewRunContext {
    reviewRunSessionId: string;
    taskSessionIds: TaskSessionMap;
    logger: ReviewExecutionLogger;
}

const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/";
const ARCHITECTURE_MODEL = process.env.REVIEW_MODEL_ARCHITECTURE || "gpt-5.4";
const CODE_MODEL = process.env.REVIEW_MODEL_CODE || "claude-opus-4.6";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COPILOT_INSTRUCTIONS_FILE = resolve(SCRIPT_DIR, "../../../.github/copilot-instructions.md");

class ReviewExecutionLogger {
    private sequenceNumber = 0;

    constructor(private readonly reviewRunSessionId: string) {}

    log(scope: "CLI" | "FS" | "AGENT" | "SDK" | "TOOLS" | "REPORT", message: string, details?: Record<string, unknown>) {
        this.sequenceNumber += 1;
        const prefix = `[review-run:${this.reviewRunSessionId}] [seq:${String(this.sequenceNumber).padStart(3, "0")}] [${scope}] ${message}`;
        const suffix = details && Object.keys(details).length > 0 ? ` ${safeStringify(details)}` : "";
        console.log(`\n\n${prefix}${suffix}\n\n`);
    }
}

function safeStringify(value: unknown): string {
    return JSON.stringify(
        value,
        (_key, currentValue) => {
            if (currentValue instanceof Error) {
                return {
                    name: currentValue.name,
                    message: currentValue.message,
                    stack: currentValue.stack,
                };
            }

            if (typeof currentValue === "string" && currentValue.length > 240) {
                return `${currentValue.slice(0, 237)}...`;
            }

            return currentValue;
        },
    );
}

function buildReviewRunSessionId(): string {
    return `review-run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function buildTaskSessionId(reviewRunSessionId: string, task: ReviewTask): string {
    return `${reviewRunSessionId}-${task.id}-${randomUUID().slice(0, 8)}`;
}

function createReviewRunContext(tasks: ReviewTask[]): ReviewRunContext {
    const reviewRunSessionId = buildReviewRunSessionId();
    const logger = new ReviewExecutionLogger(reviewRunSessionId);
    const taskSessionIds = tasks.reduce<TaskSessionMap>((map, task) => {
        map[task.id] = buildTaskSessionId(reviewRunSessionId, task);
        return map;
    }, {});

    return {
        reviewRunSessionId,
        taskSessionIds,
        logger,
    };
}

function summarizeEventData(data: unknown): unknown {
    if (!data || typeof data !== "object") {
        return data;
    }

    const record = data as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    for (const key of [
        "sessionId",
        "selectedModel",
        "toolName",
        "toolCallId",
        "message",
        "errorType",
        "statusCode",
        "providerCallId",
        "callId",
        "title",
        "content",
    ]) {
        if (record[key] !== undefined) {
            summary[key] = record[key];
        }
    }

    if (Object.keys(summary).length === 0) {
        return record;
    }

    return summary;
}

function shouldLogSessionEvent(eventType: SessionEvent["type"]): boolean {
    return !eventType.endsWith("_delta") && eventType !== "assistant.reasoning" && eventType !== "assistant.reasoning_delta";
}

function attachSessionLogging(session: CopilotSession, task: ReviewTask, logger: ReviewExecutionLogger) {
    session.on((event: SessionEvent) => {
        if (!shouldLogSessionEvent(event.type)) {
            return;
        }

        logger.log("SDK", "Session event observed", {
            taskId: task.id,
            taskTitle: task.title,
            sessionId: session.sessionId,
            eventType: event.type,
            eventId: event.id,
            data: summarizeEventData(event.data),
        });
    });
}

function parseArgs(argv: string[]): { promptFile?: string; outputFile?: string } {
    let promptFile: string | undefined;
    let outputFile: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--prompt-file") {
            promptFile = argv[index + 1];
            index += 1;
        } else if (arg === "--output-file") {
            outputFile = argv[index + 1];
            index += 1;
        }
    }

    return {
        promptFile: promptFile || process.env.REVIEW_PROMPT_FILE,
        outputFile: outputFile || process.env.REVIEW_OUTPUT_FILE,
    };
}

function inferReviewKind(filePath: string): ReviewKind {
    const normalized = filePath.toLowerCase();
    const architecturePatterns = ["architecture", "adr", "rfc", "topology", "system", "infra"];
    const designPatterns = ["design", "spec", "proposal", "ux", "ui"];
    const testPatterns = ["/test", "/tests", ".test.", ".spec.", "__tests__"];

    if (normalized.endsWith(".md") || normalized.endsWith(".mdx")) {
        if (architecturePatterns.some((pattern) => normalized.includes(pattern))) {
            return "architecture";
        }
        if (designPatterns.some((pattern) => normalized.includes(pattern))) {
            return "design";
        }
        return "design";
    }

    if (testPatterns.some((pattern) => normalized.includes(pattern))) {
        return "unit-test";
    }

    return "code";
}

function normalizeChangedFiles(config: PromptConfig, logger?: ReviewExecutionLogger): ChangedFile[] {
    const rawFiles = config.changed_files || [];
    logger?.log("AGENT", "Normalizing changed_files from review-config", {
        changedFileCount: rawFiles.length,
    });

    const normalizedFiles = rawFiles
        .map((entry) => {
            if (typeof entry === "string") {
                return { path: entry, kind: inferReviewKind(entry) } satisfies ChangedFile;
            }

            if (!entry.path) {
                return undefined;
            }

            return {
                path: entry.path,
                kind: entry.kind || inferReviewKind(entry.path),
                status: entry.status,
            } satisfies ChangedFile;
        })
        .filter((entry): entry is ChangedFile => Boolean(entry));

    logger?.log("AGENT", "Normalized changed_files", {
        changedFileCount: normalizedFiles.length,
        changedFiles: normalizedFiles,
    });

    return normalizedFiles;
}

function normalizeGithubSpaces(config: PromptConfig, logger?: ReviewExecutionLogger): GithubSpace[] {
    const declaredSpaces = config.github_spaces || [];
    logger?.log("AGENT", "Normalizing github_spaces from review-config", {
        declaredGithubSpaceCount: declaredSpaces.length,
    });

    const normalizedSpaces = declaredSpaces.filter((space) => Boolean(space?.name && space?.owner && space?.repo));
    logger?.log("AGENT", "Normalized github_spaces", {
        githubSpaceCount: normalizedSpaces.length,
        githubSpaces: normalizedSpaces.map((space) => ({
            name: space.name,
            owner: space.owner,
            repo: space.repo,
            ref: space.ref || "main",
            reviewTypes: space.review_types || [],
        })),
    });

    return normalizedSpaces;
}

async function parsePromptFile(promptFile: string, logger?: ReviewExecutionLogger): Promise<ParsedPrompt> {
    logger?.log("FS", "CLI->FS reading prompt markdown file", {
        promptFile,
    });
    const markdown = await readFile(promptFile, "utf8");
    const configMatch = markdown.match(/<!--\s*review-config\s*([\s\S]*?)-->/i);
    let config: PromptConfig = {};

    if (configMatch) {
        logger?.log("AGENT", "CLI->Agent parsing review-config block", {
            promptFile,
        });
        const configText = configMatch[1].trim();
        config = JSON.parse(configText) as PromptConfig;
    } else {
        logger?.log("AGENT", "No review-config block found in prompt markdown", {
            promptFile,
        });
    }

    return {
        markdown,
        config,
        changedFiles: normalizeChangedFiles(config, logger),
        githubSpaces: normalizeGithubSpaces(config, logger),
    };
}

async function loadDefaultCopilotInstructions(logger?: ReviewExecutionLogger): Promise<string | undefined> {
    try {
        logger?.log("FS", "CLI->FS reading default .github/copilot-instructions.md", {
            instructionsFile: DEFAULT_COPILOT_INSTRUCTIONS_FILE,
        });
        const instructions = await readFile(DEFAULT_COPILOT_INSTRUCTIONS_FILE, "utf8");
        const trimmed = instructions.trim();
        logger?.log("FS", "FS->CLI loaded default copilot instructions", {
            instructionsFile: DEFAULT_COPILOT_INSTRUCTIONS_FILE,
            loaded: trimmed.length > 0,
        });
        return trimmed.length > 0 ? trimmed : undefined;
    } catch {
        logger?.log("FS", "Default copilot instructions file missing; using built-in system message only", {
            instructionsFile: DEFAULT_COPILOT_INSTRUCTIONS_FILE,
        });
        return undefined;
    }
}

function buildReviewTasks(prompt: ParsedPrompt, logger?: ReviewExecutionLogger): ReviewTask[] {
    const requestedTypes = new Set<ReviewKind>(prompt.config.review_types || []);
    const architectureFiles = prompt.changedFiles.filter((file) => file.kind === "architecture" || file.kind === "design");
    const codeFiles = prompt.changedFiles.filter((file) => file.kind === "code" || file.kind === "unit-test");

    const tasks: ReviewTask[] = [];

    logger?.log("AGENT", "Agent building review tasks", {
        requestedReviewTypes: Array.from(requestedTypes),
        architectureFileCount: architectureFiles.length,
        codeFileCount: codeFiles.length,
    });

    if (
        architectureFiles.length > 0 ||
        requestedTypes.has("architecture") ||
        requestedTypes.has("design") ||
        /architecture|design|adr|rfc/i.test(prompt.markdown)
    ) {
        const reviewTypes = new Set<ReviewKind>();
        architectureFiles.forEach((file) => reviewTypes.add(file.kind));
        if (requestedTypes.has("architecture")) {
            reviewTypes.add("architecture");
        }
        if (requestedTypes.has("design")) {
            reviewTypes.add("design");
        }
        if (reviewTypes.size === 0) {
            reviewTypes.add("design");
        }

        const architectureTask = {
            id: "architecture-design",
            title: "Architecture and Design Review",
            model: ARCHITECTURE_MODEL,
            reviewTypes: Array.from(reviewTypes),
            files: architectureFiles,
        } satisfies ReviewTask;

        tasks.push(architectureTask);
        logger?.log("AGENT", "Created Architecture and Design Review task", {
            taskId: architectureTask.id,
            title: architectureTask.title,
            model: architectureTask.model,
            reviewTypes: architectureTask.reviewTypes,
            fileCount: architectureTask.files.length,
        });
    }

    if (
        codeFiles.length > 0 ||
        requestedTypes.has("code") ||
        /code review|unit test|implementation/i.test(prompt.markdown)
    ) {
        const reviewTypes = new Set<ReviewKind>();
        if (requestedTypes.has("code")) {
            reviewTypes.add("code");
        }
        codeFiles.forEach((file) => reviewTypes.add(file.kind));
        if (reviewTypes.size === 0) {
            reviewTypes.add("code");
        }

        const codeTask = {
            id: "code",
            title: "Code and Unit-Test Review",
            model: CODE_MODEL,
            reviewTypes: Array.from(reviewTypes),
            files: codeFiles,
        } satisfies ReviewTask;

        tasks.push(codeTask);
        logger?.log("AGENT", "Created Code and Unit-Test Review task", {
            taskId: codeTask.id,
            title: codeTask.title,
            model: codeTask.model,
            reviewTypes: codeTask.reviewTypes,
            fileCount: codeTask.files.length,
        });
    }

    if (tasks.length === 0) {
        const defaultTask = {
            id: "code",
            title: "Code and Unit-Test Review",
            model: CODE_MODEL,
            reviewTypes: ["code"],
            files: prompt.changedFiles,
        } satisfies ReviewTask;

        tasks.push(defaultTask);
        logger?.log("AGENT", "No explicit review stream inferred; defaulted to Code and Unit-Test Review", {
            taskId: defaultTask.id,
            title: defaultTask.title,
            model: defaultTask.model,
            fileCount: defaultTask.files.length,
        });
    }

    logger?.log("AGENT", "Review tasks finalized", {
        taskCount: tasks.length,
        tasks: tasks.map((task) => ({
            id: task.id,
            title: task.title,
            model: task.model,
            reviewTypes: task.reviewTypes,
            fileCount: task.files.length,
        })),
    });

    return tasks;
}

function buildTools(prompt: ParsedPrompt, tasks: ReviewTask[], logger: ReviewExecutionLogger) {
    const listReviewTasks = defineTool("list_review_tasks", {
        description: "List the review tasks derived from the markdown prompt file.",
        parameters: {
            type: "object",
            properties: {},
        },
        handler: async () => {
            logger.log("TOOLS", "SDK->Tools list_review_tasks invoked", {
                taskCount: tasks.length,
            });

            const response = {
                tasks: tasks.map((task) => ({
                    id: task.id,
                    title: task.title,
                    model: task.model,
                    reviewTypes: task.reviewTypes,
                    files: task.files,
                })),
            };

            logger.log("TOOLS", "Tools--SDK list_review_tasks returned derived review streams", {
                taskCount: response.tasks.length,
            });

            return response;
        },
    });

    const listGithubSpaces = defineTool("list_github_spaces", {
        description: "List the GitHub Spaces declared by the markdown prompt file.",
        parameters: {
            type: "object",
            properties: {
                reviewType: {
                    type: "string",
                    description: "Optional filter for architecture, design, or code.",
                },
            },
        },
        handler: async ({ reviewType }: { reviewType?: ReviewKind }) => {
            logger.log("TOOLS", "SDK->Tools list_github_spaces invoked", {
                reviewType: reviewType || null,
            });

            const response = {
                spaces: prompt.githubSpaces
                    .filter((space) => !reviewType || !space.review_types || space.review_types.includes(reviewType))
                    .map((space) => ({
                        name: space.name,
                        owner: space.owner,
                        repo: space.repo,
                        ref: space.ref || "main",
                        reviewTypes: space.review_types || [],
                        instructionCount: space.instructions?.length || 0,
                        contextCount: space.context?.length || 0,
                        description: space.description || null,
                    })),
            };

            logger.log("TOOLS", "Tools--SDK list_github_spaces returned matching GitHub Spaces", {
                reviewType: reviewType || null,
                githubSpaceCount: response.spaces.length,
                githubSpaces: response.spaces.map((space) => space.name),
            });

            return response;
        },
    });

    const getGithubSpace = defineTool("get_github_space", {
        description: "Get the repository, ref, and markdown paths for a declared GitHub Space.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "GitHub Space name from list_github_spaces.",
                },
            },
            required: ["name"],
        },
        handler: async ({ name }: { name: string }) => {
            logger.log("TOOLS", "SDK->Tools get_github_space invoked", {
                name,
            });

            const match = prompt.githubSpaces.find((space) => space.name === name);
            if (!match) {
                const missingResponse = {
                    found: false,
                    message: `GitHub Space '${name}' is not declared in the prompt file.`,
                };

                logger.log("TOOLS", "Tools--SDK get_github_space returned no match", {
                    name,
                });

                return missingResponse;
            }

            const response = {
                found: true,
                space: {
                    ...match,
                    ref: match.ref || "main",
                },
                retrievalPlan: {
                    repository: `${match.owner}/${match.repo}`,
                    ref: match.ref || "main",
                    instructionPaths: match.instructions || [],
                    contextPaths: match.context || [],
                    guidance: "Use the GitHub MCP server against the declared repository and ref to fetch these markdown files before reviewing.",
                },
            };

            logger.log("TOOLS", "Tools--SDK get_github_space returned retrieval plan", {
                name,
                repository: response.retrievalPlan.repository,
                ref: response.retrievalPlan.ref,
                instructionPaths: response.retrievalPlan.instructionPaths,
                contextPaths: response.retrievalPlan.contextPaths,
            });

            return response;
        },
    });

    return [listReviewTasks, listGithubSpaces, getGithubSpace];
}

function permissionHandler(request: { kind: string }) {
    if (["read", "mcp", "custom-tool", "url"].includes(request.kind)) {
        return { kind: "approved" as const };
    }

    return {
        kind: "denied-interactively-by-user" as const,
        feedback: "The review agent runs in read-only mode.",
    };
}

function buildSystemMessage(task: ReviewTask, reviewRunContext: ReviewRunContext, defaultInstructions?: string): { content: string } {
    const defaultInstructionsSection = defaultInstructions
        ? `Default copilot instructions from .github/copilot-instructions.md:\n${defaultInstructions}\n\n`
        : "";
    const taskSessionId = reviewRunContext.taskSessionIds[task.id] || "unknown";

    return {
        content: `You are the generic review agent for ${task.title}.

Operate as a read-only reviewer.

Execution context:
- Shared review run session ID: ${reviewRunContext.reviewRunSessionId}
- This review sub-agent session ID: ${taskSessionId}
- Run sibling review tasks independently and do not wait for the other stream.

Workflow rules:
- The attached markdown file is the source of truth for the request.
- Call list_review_tasks before reviewing.
- Call list_github_spaces, then get_github_space for any relevant external guidance.
- Use the GitHub MCP server to retrieve the instruction and context markdown files declared by the selected GitHub Space.
- Review only the files relevant to this task.
- Do not modify files.
- Produce markdown with the headings Summary, Findings, and Recommendations.
- If there are no findings, state that explicitly and describe residual risk.

Review focus:
- Architecture/design reviews should assess boundaries, trade-offs, requirements coverage, operational concerns, and design clarity.
- Code reviews should assess correctness, regressions, unit tests, maintainability, and security concerns.

${defaultInstructionsSection}`,
    };
}

function buildTaskPrompt(task: ReviewTask, prompt: ParsedPrompt, reviewRunContext: ReviewRunContext): string {
    const pr = prompt.config.pull_request || {};
    const fileList = task.files.length > 0 ? task.files.map((file) => `- ${file.path} (${file.kind})`).join("\n") : "- No explicit file list provided in the prompt configuration.";
    const taskSessionId = reviewRunContext.taskSessionIds[task.id] || "unknown";

    return `Execute the ${task.title} using model routing already selected by the host.

Session context:
- Shared review run session ID: ${reviewRunContext.reviewRunSessionId}
- This review sub-agent session ID: ${taskSessionId}

Pull request context:
- Number: ${pr.number ?? "n/a"}
- Title: ${pr.title ?? "n/a"}
- URL: ${pr.url ?? "n/a"}
- Base ref: ${pr.base_ref ?? "n/a"}
- Head ref: ${pr.head_ref ?? "n/a"}

Relevant changed files:
${fileList}

Use the attached markdown prompt file first. Then load any required GitHub Space guidance through the GitHub MCP server and produce the review report for ${task.title}.`;
}

async function runReviewTask(
    client: CopilotClient,
    promptFile: string,
    prompt: ParsedPrompt,
    task: ReviewTask,
    tools: ReturnType<typeof buildTools>,
    reviewRunContext: ReviewRunContext,
    defaultInstructions?: string,
): Promise<string> {
    const logger = reviewRunContext.logger;
    const taskSessionId = reviewRunContext.taskSessionIds[task.id] || buildTaskSessionId(reviewRunContext.reviewRunSessionId, task);

    logger.log("AGENT", "Agent->SDK createSession for review sub-agent", {
        taskId: task.id,
        taskTitle: task.title,
        reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        taskSessionId,
        model: task.model,
        reviewTypes: task.reviewTypes,
    });

    const session = await client.createSession({
        sessionId: taskSessionId,
        model: task.model,
        tools,
        mcpServers: {
            github: {
                type: "http",
                url: GITHUB_MCP_URL,
                tools: ["*"],
            },
        },
        systemMessage: buildSystemMessage(task, reviewRunContext, defaultInstructions),
        onPermissionRequest: permissionHandler,
    });

    attachSessionLogging(session, task, logger);
    logger.log("SDK", "SDK session created for review sub-agent", {
        taskId: task.id,
        taskTitle: task.title,
        sessionId: session.sessionId,
        reviewRunSessionId: reviewRunContext.reviewRunSessionId,
    });

    try {
        logger.log("SDK", "Agent->SDK sendAndWait dispatched for review sub-agent", {
            taskId: task.id,
            taskTitle: task.title,
            sessionId: session.sessionId,
            promptFile,
        });

        const response = await session.sendAndWait({
            prompt: buildTaskPrompt(task, prompt, reviewRunContext),
            attachments: [
                {
                    type: "file",
                    path: promptFile,
                    displayName: basename(promptFile),
                },
            ],
        });

        logger.log("SDK", "SDK--Agent review sub-agent completed", {
            taskId: task.id,
            taskTitle: task.title,
            sessionId: session.sessionId,
            responseReceived: Boolean(response?.data.content),
        });

        return response?.data.content || `## ${task.title}\n\nNo response was returned by the model.`;
    } finally {
        logger.log("SDK", "Agent->SDK disconnecting review sub-agent session", {
            taskId: task.id,
            taskTitle: task.title,
            sessionId: session.sessionId,
        });
        await session.disconnect();
        logger.log("SDK", "Review sub-agent session disconnected", {
            taskId: task.id,
            taskTitle: task.title,
            sessionId: session.sessionId,
        });
    }
}

function composeFinalReport(prompt: ParsedPrompt, tasks: ReviewTask[], outputs: string[], reviewRunContext: ReviewRunContext): string {
    const pr = prompt.config.pull_request || {};
    const sessionLines = tasks.map((task) => `- ${task.title} session: ${reviewRunContext.taskSessionIds[task.id] || "n/a"}`);
    const header = [
        "# Review Report",
        "",
        "## Request",
        `- Pull request: ${pr.title || "n/a"}`,
        `- URL: ${pr.url || "n/a"}`,
        `- Shared review run session: ${reviewRunContext.reviewRunSessionId}`,
        ...sessionLines,
        `- Review streams: ${tasks.map((task) => task.title).join(", ")}`,
        `- GitHub Spaces declared: ${prompt.githubSpaces.map((space) => space.name).join(", ") || "none"}`,
        "",
    ].join("\n");

    const sections = outputs.map((output, index) => `## ${tasks[index].title}\n\n${output.trim()}`).join("\n\n");
    return `${header}${sections}\n`;
}

async function main() {
    const { promptFile, outputFile } = parseArgs(process.argv.slice(2));
    if (!promptFile) {
        throw new Error("A markdown prompt file is required. Pass --prompt-file <path> or set REVIEW_PROMPT_FILE.");
    }

    const bootstrapLogger = new ReviewExecutionLogger("bootstrap");
    bootstrapLogger.log("CLI", "User->CLI review agent invoked", {
        promptFile,
        outputFile: outputFile || null,
    });

    const resolvedPromptFile = resolve(promptFile);
    bootstrapLogger.log("CLI", "CLI resolved prompt path", {
        resolvedPromptFile,
    });

    const parsedPrompt = await parsePromptFile(resolvedPromptFile, bootstrapLogger);
    const defaultInstructions = await loadDefaultCopilotInstructions(bootstrapLogger);
    const tasks = buildReviewTasks(parsedPrompt, bootstrapLogger);
    const reviewRunContext = createReviewRunContext(tasks);
    const logger = reviewRunContext.logger;

    logger.log("CLI", "Review run session initialized", {
        reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        taskSessionIds: reviewRunContext.taskSessionIds,
    });

    const tools = buildTools(parsedPrompt, tasks, logger);
    const client = new CopilotClient();

    logger.log("SDK", "CLI->SDK starting CopilotClient", {
        reviewRunSessionId: reviewRunContext.reviewRunSessionId,
    });
    await client.start();
    logger.log("SDK", "CopilotClient started", {
        reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        taskCount: tasks.length,
    });

    try {
        logger.log("AGENT", "Agent launching review sub-agents in parallel", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
            taskCount: tasks.length,
            tasks: tasks.map((task) => ({
                id: task.id,
                title: task.title,
                sessionId: reviewRunContext.taskSessionIds[task.id] || null,
            })),
        });

        const outputs = await Promise.all(
            tasks.map((task) => runReviewTask(client, resolvedPromptFile, parsedPrompt, task, tools, reviewRunContext, defaultInstructions)),
        );
        logger.log("AGENT", "All review sub-agents completed", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
            completedTaskCount: outputs.length,
        });

        logger.log("REPORT", "Agent composing final report from review sub-agent outputs", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
            taskCount: tasks.length,
        });
        const report = composeFinalReport(parsedPrompt, tasks, outputs, reviewRunContext);

        logger.log("CLI", "CLI printing combined review report to stdout", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        });
        process.stdout.write(report);
        if (outputFile) {
            logger.log("FS", "CLI->FS writing combined review report", {
                reviewRunSessionId: reviewRunContext.reviewRunSessionId,
                outputFile: resolve(outputFile),
            });
            await writeFile(resolve(outputFile), report, "utf8");
        }
    } finally {
        logger.log("SDK", "CLI->SDK stopping CopilotClient", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        });
        await client.stop();
        logger.log("SDK", "CopilotClient stopped", {
            reviewRunSessionId: reviewRunContext.reviewRunSessionId,
        });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});