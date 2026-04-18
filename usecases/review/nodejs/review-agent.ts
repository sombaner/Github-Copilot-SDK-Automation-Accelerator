import { basename, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { CopilotClient, defineTool } from "@github/copilot-sdk";

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

const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/";
const ARCHITECTURE_MODEL = process.env.REVIEW_MODEL_ARCHITECTURE || "gpt-5.4";
const CODE_MODEL = process.env.REVIEW_MODEL_CODE || "claude-opus-4.6";

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

function normalizeChangedFiles(config: PromptConfig): ChangedFile[] {
    const rawFiles = config.changed_files || [];
    return rawFiles
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
}

function normalizeGithubSpaces(config: PromptConfig): GithubSpace[] {
    return (config.github_spaces || []).filter((space) => Boolean(space?.name && space?.owner && space?.repo));
}

async function parsePromptFile(promptFile: string): Promise<ParsedPrompt> {
    const markdown = await readFile(promptFile, "utf8");
    const configMatch = markdown.match(/<!--\s*review-config\s*([\s\S]*?)-->/i);
    let config: PromptConfig = {};

    if (configMatch) {
        const configText = configMatch[1].trim();
        config = JSON.parse(configText) as PromptConfig;
    }

    return {
        markdown,
        config,
        changedFiles: normalizeChangedFiles(config),
        githubSpaces: normalizeGithubSpaces(config),
    };
}

function buildReviewTasks(prompt: ParsedPrompt): ReviewTask[] {
    const requestedTypes = new Set<ReviewKind>(prompt.config.review_types || []);
    const architectureFiles = prompt.changedFiles.filter((file) => file.kind === "architecture" || file.kind === "design");
    const codeFiles = prompt.changedFiles.filter((file) => file.kind === "code" || file.kind === "unit-test");

    const tasks: ReviewTask[] = [];

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

        tasks.push({
            id: "architecture-design",
            title: "Architecture and Design Review",
            model: ARCHITECTURE_MODEL,
            reviewTypes: Array.from(reviewTypes),
            files: architectureFiles,
        });
    }

    if (
        codeFiles.length > 0 ||
        requestedTypes.has("code") ||
        /code review|unit test|implementation/i.test(prompt.markdown)
    ) {
        const reviewTypes = new Set<ReviewKind>();
        codeFiles.forEach((file) => reviewTypes.add(file.kind));
        if (requestedTypes.has("code")) {
            reviewTypes.add("code");
        }
        if (reviewTypes.size === 0) {
            reviewTypes.add("code");
        }

        tasks.push({
            id: "code",
            title: "Code and Unit-Test Review",
            model: CODE_MODEL,
            reviewTypes: Array.from(reviewTypes),
            files: codeFiles,
        });
    }

    if (tasks.length === 0) {
        tasks.push({
            id: "code",
            title: "Code and Unit-Test Review",
            model: CODE_MODEL,
            reviewTypes: ["code"],
            files: prompt.changedFiles,
        });
    }

    return tasks;
}

function buildTools(prompt: ParsedPrompt, tasks: ReviewTask[]) {
    const listReviewTasks = defineTool("list_review_tasks", {
        description: "List the review tasks derived from the markdown prompt file.",
        parameters: {
            type: "object",
            properties: {},
        },
        handler: async () => ({
            tasks: tasks.map((task) => ({
                id: task.id,
                title: task.title,
                model: task.model,
                reviewTypes: task.reviewTypes,
                files: task.files,
            })),
        }),
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
        handler: async ({ reviewType }: { reviewType?: ReviewKind }) => ({
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
        }),
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
            const match = prompt.githubSpaces.find((space) => space.name === name);
            if (!match) {
                return {
                    found: false,
                    message: `GitHub Space '${name}' is not declared in the prompt file.`,
                };
            }

            return {
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

function buildSystemMessage(task: ReviewTask): { content: string } {
    return {
        content: `You are the generic review agent for ${task.title}.

Operate as a read-only reviewer.

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
`,
    };
}

function buildTaskPrompt(task: ReviewTask, prompt: ParsedPrompt): string {
    const pr = prompt.config.pull_request || {};
    const fileList = task.files.length > 0 ? task.files.map((file) => `- ${file.path} (${file.kind})`).join("\n") : "- No explicit file list provided in the prompt configuration.";
    const instructions = (prompt.config.instructions || []).map((item) => `- ${item}`).join("\n") || "- No extra review instructions were supplied.";

    return `Execute the ${task.title} using model routing already selected by the host.

Pull request context:
- Number: ${pr.number ?? "n/a"}
- Title: ${pr.title ?? "n/a"}
- URL: ${pr.url ?? "n/a"}
- Base ref: ${pr.base_ref ?? "n/a"}
- Head ref: ${pr.head_ref ?? "n/a"}

Relevant changed files:
${fileList}

Additional instructions:
${instructions}

Use the attached markdown prompt file first. Then load any required GitHub Space guidance through the GitHub MCP server and produce the review report for ${task.title}.`;
}

async function runReviewTask(client: CopilotClient, promptFile: string, prompt: ParsedPrompt, task: ReviewTask, tools: ReturnType<typeof buildTools>): Promise<string> {
    const session = await client.createSession({
        model: task.model,
        tools,
        mcpServers: {
            github: {
                type: "http",
                url: GITHUB_MCP_URL,
                tools: ["*"],
            },
        },
        systemMessage: buildSystemMessage(task),
        onPermissionRequest: permissionHandler,
    });

    try {
        const response = await session.sendAndWait({
            prompt: buildTaskPrompt(task, prompt),
            attachments: [
                {
                    type: "file",
                    path: promptFile,
                    displayName: basename(promptFile),
                },
            ],
        });

        return response?.data.content || `## ${task.title}\n\nNo response was returned by the model.`;
    } finally {
        await session.disconnect();
    }
}

function composeFinalReport(prompt: ParsedPrompt, tasks: ReviewTask[], outputs: string[]): string {
    const pr = prompt.config.pull_request || {};
    const header = [
        "# Review Report",
        "",
        "## Request",
        `- Pull request: ${pr.title || "n/a"}`,
        `- URL: ${pr.url || "n/a"}`,
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

    const resolvedPromptFile = resolve(promptFile);
    const parsedPrompt = await parsePromptFile(resolvedPromptFile);
    const tasks = buildReviewTasks(parsedPrompt);
    const tools = buildTools(parsedPrompt, tasks);
    const client = new CopilotClient();

    await client.start();

    try {
        const outputs = await Promise.all(tasks.map((task) => runReviewTask(client, resolvedPromptFile, parsedPrompt, task, tools)));
        const report = composeFinalReport(parsedPrompt, tasks, outputs);

        process.stdout.write(report);
        if (outputFile) {
            await writeFile(resolve(outputFile), report, "utf8");
        }
    } finally {
        await client.stop();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});