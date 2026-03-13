import { CopilotClient, defineTool, SessionEvent, approveAll } from "@github/copilot-sdk";
import PptxGenJS from "pptxgenjs";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

/**
 * PPT Generator Agent
 *
 * An AI-powered PowerPoint presentation generator built with the GitHub Copilot SDK.
 * Uses Claude Opus 4.6 to understand prompts, leverage agent skills, and invoke
 * custom tools to produce polished .pptx files.
 *
 * Features:
 * - Accepts a user prompt describing the desired presentation
 * - Accepts agent skills as input to shape content & style
 * - Custom tools for slide creation, theming, chart insertion, and file export
 * - Uses Claude Opus 4.6 for intelligent content generation
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlideContent {
    title: string;
    body?: string;
    bullets?: string[];
    notes?: string;
    layout?: "title" | "content" | "section" | "two-column" | "image" | "comparison" | "chart";
    chartData?: { label: string; value: number }[];
    leftColumn?: string;
    rightColumn?: string;
    imageUrl?: string;
    imageCaption?: string;
}

interface ThemeConfig {
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    fontFamily: string;
    titleFontSize: number;
    bodyFontSize: number;
    backgroundColor: string;
}

// ─── In-Memory Presentation State ────────────────────────────────────────────

let presentationTitle = "Untitled Presentation";
let slides: SlideContent[] = [];
let currentTheme: ThemeConfig = {
    primaryColor: "003366",
    secondaryColor: "0066CC",
    accentColor: "FF6600",
    fontFamily: "Calibri",
    titleFontSize: 28,
    bodyFontSize: 16,
    backgroundColor: "FFFFFF",
};
let agentSkills: string[] = [];

// ─── Custom Tools ────────────────────────────────────────────────────────────

/**
 * Tool: set_presentation_metadata
 * Sets the overall presentation title and optional agent skills context.
 */
const setPresentationMetadata = defineTool("set_presentation_metadata", {
    description:
        "Set the presentation title and optional agent skills. Call this first before adding slides.",
    parameters: {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "Title of the presentation",
            },
            skills: {
                type: "array",
                items: { type: "string" },
                description:
                    "Agent skills to apply (e.g. 'concise', 'technical', 'storytelling', 'data-driven', 'executive-summary')",
            },
        },
        required: ["title"],
    },
    handler: async (args: { title: string; skills?: string[] }) => {
        presentationTitle = args.title;
        if (args.skills) {
            agentSkills = args.skills;
        }
        slides = []; // reset slides on new presentation
        return {
            status: "metadata_set",
            title: presentationTitle,
            skills: agentSkills,
            message: `Presentation "${presentationTitle}" initialised with skills: [${agentSkills.join(", ")}]`,
        };
    },
});

/**
 * Tool: set_theme
 * Configures visual theme (colors, fonts, sizes) for the entire presentation.
 */
const setTheme = defineTool("set_theme", {
    description:
        "Set the visual theme for the presentation including colors, fonts, and sizes",
    parameters: {
        type: "object",
        properties: {
            primaryColor: {
                type: "string",
                description: "Primary colour hex (without #), e.g. '003366'",
            },
            secondaryColor: {
                type: "string",
                description: "Secondary colour hex, e.g. '0066CC'",
            },
            accentColor: {
                type: "string",
                description: "Accent colour hex, e.g. 'FF6600'",
            },
            fontFamily: {
                type: "string",
                description: "Font family name, e.g. 'Calibri', 'Arial', 'Helvetica'",
            },
            titleFontSize: {
                type: "number",
                description: "Font size for titles in points",
            },
            bodyFontSize: {
                type: "number",
                description: "Font size for body text in points",
            },
            backgroundColor: {
                type: "string",
                description: "Slide background colour hex, e.g. 'FFFFFF'",
            },
        },
        required: [],
    },
    handler: async (args: Partial<ThemeConfig>) => {
        currentTheme = { ...currentTheme, ...args };
        return {
            status: "theme_updated",
            theme: currentTheme,
        };
    },
});

/**
 * Tool: add_slide
 * Adds a single slide to the presentation with flexible layout options.
 */
const addSlide = defineTool("add_slide", {
    description:
        "Add a slide to the presentation. Supports layouts: title, content, section, two-column, comparison, chart, image.",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "Slide title" },
            body: { type: "string", description: "Main body text (for content layout)" },
            bullets: {
                type: "array",
                items: { type: "string" },
                description: "Bullet points (for content layout)",
            },
            notes: { type: "string", description: "Speaker notes" },
            layout: {
                type: "string",
                enum: ["title", "content", "section", "two-column", "image", "comparison", "chart"],
                description: "Slide layout type",
            },
            chartData: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string" },
                        value: { type: "number" },
                    },
                },
                description: "Data for chart slide (array of {label, value})",
            },
            leftColumn: { type: "string", description: "Left column text (two-column/comparison)" },
            rightColumn: { type: "string", description: "Right column text (two-column/comparison)" },
            imageUrl: { type: "string", description: "Image URL or path (image layout)" },
            imageCaption: { type: "string", description: "Image caption (image layout)" },
        },
        required: ["title"],
    },
    handler: async (args: SlideContent) => {
        slides.push({ ...args, layout: args.layout || "content" });
        return {
            status: "slide_added",
            slideNumber: slides.length,
            title: args.title,
            layout: args.layout || "content",
            totalSlides: slides.length,
        };
    },
});

/**
 * Tool: list_slides
 * Returns the current slide deck outline for review before exporting.
 */
const listSlides = defineTool("list_slides", {
    description: "List all slides currently in the presentation for review",
    parameters: {
        type: "object",
        properties: {},
        required: [],
    },
    handler: async () => {
        return {
            presentationTitle,
            theme: currentTheme,
            skills: agentSkills,
            totalSlides: slides.length,
            slides: slides.map((s, i) => ({
                number: i + 1,
                title: s.title,
                layout: s.layout,
                hasBullets: !!s.bullets?.length,
                hasChart: !!s.chartData?.length,
                hasNotes: !!s.notes,
            })),
        };
    },
});

/**
 * Tool: remove_slide
 * Removes a slide by its 1-based index.
 */
const removeSlide = defineTool("remove_slide", {
    description: "Remove a slide from the presentation by its slide number (1-based)",
    parameters: {
        type: "object",
        properties: {
            slideNumber: {
                type: "number",
                description: "Slide number to remove (1-based)",
            },
        },
        required: ["slideNumber"],
    },
    handler: async (args: { slideNumber: number }) => {
        const idx = args.slideNumber - 1;
        if (idx < 0 || idx >= slides.length) {
            return { status: "error", message: `Invalid slide number ${args.slideNumber}. Total slides: ${slides.length}` };
        }
        const removed = slides.splice(idx, 1)[0];
        return {
            status: "slide_removed",
            removedTitle: removed.title,
            totalSlides: slides.length,
        };
    },
});

/**
 * Tool: export_pptx
 * Renders the slides into a .pptx file using pptxgenjs and writes to disk.
 */
const exportPptx = defineTool("export_pptx", {
    description:
        "Export the current presentation to a .pptx file. Call this after all slides have been added.",
    parameters: {
        type: "object",
        properties: {
            filename: {
                type: "string",
                description: "Output filename (without extension). Defaults to the presentation title.",
            },
            outputDir: {
                type: "string",
                description: "Output directory path. Defaults to './output'.",
            },
        },
        required: [],
    },
    handler: async (args: { filename?: string; outputDir?: string }) => {
        if (slides.length === 0) {
            return { status: "error", message: "No slides to export. Add slides first." };
        }

        const pptx = new PptxGenJS();
        pptx.title = presentationTitle;
        pptx.author = "Copilot SDK PPT Generator Agent";
        pptx.subject = presentationTitle;

        // Define a master slide with theme
        pptx.defineSlideMaster({
            title: "MASTER_SLIDE",
            background: { color: currentTheme.backgroundColor },
            objects: [
                {
                    rect: {
                        x: 0,
                        y: 0,
                        w: "100%",
                        h: 0.6,
                        fill: { color: currentTheme.primaryColor },
                    },
                },
                {
                    text: {
                        text: presentationTitle,
                        options: {
                            x: 0.5,
                            y: 0.08,
                            w: 9,
                            h: 0.45,
                            color: "FFFFFF",
                            fontFace: currentTheme.fontFamily,
                            fontSize: 12,
                            bold: true,
                        },
                    },
                },
            ],
        });

        for (const slideContent of slides) {
            const slide = pptx.addSlide({ masterName: "MASTER_SLIDE" });

            if (slideContent.notes) {
                slide.addNotes(slideContent.notes);
            }

            switch (slideContent.layout) {
                case "title":
                    // Title slide — big centred title + optional subtitle
                    slide.background = { color: currentTheme.primaryColor };
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 1.5,
                        w: 9,
                        h: 1.5,
                        fontSize: currentTheme.titleFontSize + 8,
                        fontFace: currentTheme.fontFamily,
                        color: "FFFFFF",
                        bold: true,
                        align: "center",
                        valign: "middle",
                    });
                    if (slideContent.body) {
                        slide.addText(slideContent.body, {
                            x: 1.5,
                            y: 3.2,
                            w: 7,
                            h: 1,
                            fontSize: currentTheme.bodyFontSize + 4,
                            fontFace: currentTheme.fontFamily,
                            color: "CCDDEE",
                            align: "center",
                            valign: "middle",
                        });
                    }
                    break;

                case "section":
                    // Section divider
                    slide.background = { color: currentTheme.secondaryColor };
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 2,
                        w: 9,
                        h: 1.5,
                        fontSize: currentTheme.titleFontSize + 4,
                        fontFace: currentTheme.fontFamily,
                        color: "FFFFFF",
                        bold: true,
                        align: "center",
                        valign: "middle",
                    });
                    break;

                case "two-column":
                case "comparison":
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 0.8,
                        w: 9,
                        h: 0.6,
                        fontSize: currentTheme.titleFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: currentTheme.primaryColor,
                        bold: true,
                    });
                    // Left column
                    slide.addText(slideContent.leftColumn || "", {
                        x: 0.5,
                        y: 1.6,
                        w: 4.2,
                        h: 3.5,
                        fontSize: currentTheme.bodyFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: "333333",
                        valign: "top",
                        paraSpaceBefore: 6,
                    });
                    // Right column
                    slide.addText(slideContent.rightColumn || "", {
                        x: 5.3,
                        y: 1.6,
                        w: 4.2,
                        h: 3.5,
                        fontSize: currentTheme.bodyFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: "333333",
                        valign: "top",
                        paraSpaceBefore: 6,
                    });
                    // Divider line
                    slide.addShape(pptx.ShapeType.line, {
                        x: 4.9,
                        y: 1.6,
                        w: 0,
                        h: 3.5,
                        line: { color: currentTheme.accentColor, width: 1.5 },
                    });
                    break;

                case "chart":
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 0.8,
                        w: 9,
                        h: 0.6,
                        fontSize: currentTheme.titleFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: currentTheme.primaryColor,
                        bold: true,
                    });
                    if (slideContent.chartData && slideContent.chartData.length > 0) {
                        slide.addChart(pptx.ChartType.bar, [
                            {
                                name: slideContent.title,
                                labels: slideContent.chartData.map((d) => d.label),
                                values: slideContent.chartData.map((d) => d.value),
                            },
                        ], {
                            x: 0.5,
                            y: 1.6,
                            w: 9,
                            h: 3.5,
                            showValue: true,
                            chartColors: [currentTheme.accentColor],
                        });
                    }
                    break;

                case "image":
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 0.8,
                        w: 9,
                        h: 0.6,
                        fontSize: currentTheme.titleFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: currentTheme.primaryColor,
                        bold: true,
                    });
                    // Placeholder rectangle for image
                    slide.addShape(pptx.ShapeType.rect, {
                        x: 1.5,
                        y: 1.6,
                        w: 7,
                        h: 3,
                        fill: { color: "F0F0F0" },
                        line: { color: "CCCCCC", width: 1 },
                    });
                    slide.addText(slideContent.imageCaption || slideContent.imageUrl || "[Image placeholder]", {
                        x: 1.5,
                        y: 2.5,
                        w: 7,
                        h: 1,
                        fontSize: currentTheme.bodyFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: "999999",
                        align: "center",
                        valign: "middle",
                    });
                    break;

                case "content":
                default:
                    // Standard content slide
                    slide.addText(slideContent.title, {
                        x: 0.5,
                        y: 0.8,
                        w: 9,
                        h: 0.6,
                        fontSize: currentTheme.titleFontSize,
                        fontFace: currentTheme.fontFamily,
                        color: currentTheme.primaryColor,
                        bold: true,
                    });

                    if (slideContent.bullets && slideContent.bullets.length > 0) {
                        const bulletRows = slideContent.bullets.map((b) => ({
                            text: b,
                            options: {
                                bullet: { code: "2022" },
                                indentLevel: 0,
                                paraSpaceBefore: 8,
                            },
                        }));
                        slide.addText(bulletRows, {
                            x: 0.5,
                            y: 1.6,
                            w: 9,
                            h: 3.5,
                            fontSize: currentTheme.bodyFontSize,
                            fontFace: currentTheme.fontFamily,
                            color: "333333",
                            valign: "top",
                        });
                    } else if (slideContent.body) {
                        slide.addText(slideContent.body, {
                            x: 0.5,
                            y: 1.6,
                            w: 9,
                            h: 3.5,
                            fontSize: currentTheme.bodyFontSize,
                            fontFace: currentTheme.fontFamily,
                            color: "333333",
                            valign: "top",
                            paraSpaceBefore: 6,
                        });
                    }
                    break;
            }
        }

        // Write file
        const outDir = args.outputDir || "./output";
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        const safeName = (args.filename || presentationTitle)
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .substring(0, 100);
        const filePath = path.join(outDir, `${safeName}.pptx`);

        await pptx.writeFile({ fileName: filePath });

        return {
            status: "exported",
            filePath,
            totalSlides: slides.length,
            title: presentationTitle,
            message: `Presentation exported to ${filePath} (${slides.length} slides)`,
        };
    },
});

// ─── Agent Startup ───────────────────────────────────────────────────────────

async function startPptGeneratorAgent() {
    console.log("📊 PPT Generator Agent starting...\n");

    const client = new CopilotClient();

    // Gather optional skills from CLI args: --skills "concise,technical,storytelling"
    const skillsArg = process.argv.find((a) => a.startsWith("--skills="));
    const inputSkills = skillsArg
        ? skillsArg.split("=")[1].split(",").map((s) => s.trim())
        : [];

    const skillsPromptSection =
        inputSkills.length > 0
            ? `\n\nAgent skills active for this session: [${inputSkills.join(", ")}].
Adapt your content generation style according to these skills:
- "concise": keep text short and punchy, favour bullets over paragraphs
- "technical": use precise terminology, include code snippets or architecture diagrams where relevant
- "storytelling": structure the presentation as a narrative arc with intro, conflict, resolution
- "data-driven": emphasise numbers, charts, and evidence; use the chart slide layout when data is available
- "executive-summary": high-level overview, limit to 6-8 slides, focus on outcomes and recommendations
- "creative": use bold colour themes, metaphors, and visual variety
- Any other skill: interpret it as a content-styling directive and apply accordingly.`
            : "";

    const session = await client.createSession({
        model: "claude-opus-4.6",
        streaming: true,
        onPermissionRequest: approveAll,
        tools: [
            setPresentationMetadata,
            setTheme,
            addSlide,
            listSlides,
            removeSlide,
            exportPptx,
        ],
        systemMessage: {
            content: `You are an expert presentation designer and content strategist. Your role is to:

1. Understand the user's prompt and create a professional PowerPoint presentation.
2. Use the provided tools to build the presentation step by step:
   a. First call set_presentation_metadata to set the title and any active skills.
   b. Optionally call set_theme to customise colours/fonts if the user requests a specific look.
   c. Call add_slide repeatedly to build out each slide with the appropriate layout.
   d. Call list_slides to review the deck before exporting.
   e. Call export_pptx to generate the final .pptx file.
3. Choose the best slide layout for each piece of content:
   - "title" for the opening slide
   - "section" for section dividers
   - "content" for standard bullet or text slides
   - "two-column" or "comparison" for side-by-side information
   - "chart" when presenting numerical data
   - "image" when referencing visuals
4. Always add speaker notes to every slide.
5. Apply the active agent skills to shape content tone, depth, and structure.
6. Keep individual slides focused — one key idea per slide.
7. End with a summary or call-to-action slide.
${skillsPromptSection}`,
        },
    });

    session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
            process.stdout.write(event.data.deltaContent);
        }
        if (event.type === "tool.execution_start") {
            console.log(`\n🔧 [Tool: ${event.data.toolCallId}]`);
        }
        if (event.type === "tool.execution_complete") {
            console.log(`✅ [Done: ${event.data.toolCallId}]`);
        }
        if (event.type === "session.error") {
            console.error(`\n❌ Error: ${JSON.stringify(event.data)}`);
        }
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log("🚀 PPT Generator Agent Ready!");
    console.log("=".repeat(60));
    console.log(`   Model  : claude-opus-4.6`);
    if (inputSkills.length > 0) {
        console.log(`   Skills : ${inputSkills.join(", ")}`);
    }
    console.log(`   Output : ./output/`);
    console.log("=".repeat(60));
    console.log("\nDescribe the presentation you want to create.");
    console.log("Type 'exit' to quit.\n");

    const prompt = () => {
        rl.question("You: ", async (input) => {
            if (input.toLowerCase() === "exit") {
                console.log("\n👋 Shutting down PPT Generator Agent...");
                await client.stop();
                rl.close();
                process.exit(0);
            }
            if (!input.trim()) {
                prompt();
                return;
            }

            process.stdout.write("\nAssistant: ");
            await session.sendAndWait({ prompt: input }, 100000);
            console.log("\n");
            prompt();
        });
    };

    prompt();
}

// ─── Main ────────────────────────────────────────────────────────────────────

startPptGeneratorAgent().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
