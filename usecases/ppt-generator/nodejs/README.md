# PPT Generator Agent — Node.js

AI-powered PowerPoint presentation generator built with the GitHub Copilot SDK and Claude Opus 4.6.

## Quick Start

```bash
npm install
npx tsx ppt-generator-agent.ts
```

## With Agent Skills

Pass skills to customize content generation style:

```bash
npx tsx ppt-generator-agent.ts --skills="concise,data-driven"
npx tsx ppt-generator-agent.ts --skills="storytelling,creative"
npx tsx ppt-generator-agent.ts --skills="technical,executive-summary"
```

## Available Skills

| Skill | Effect |
|-------|--------|
| `concise` | Short punchy text, bullet-heavy |
| `technical` | Precise terminology, architecture details |
| `storytelling` | Narrative arc structure |
| `data-driven` | Charts, numbers, evidence |
| `executive-summary` | High-level, 6-8 slides max |
| `creative` | Bold themes, metaphors, visual variety |

## Custom Tools

| Tool | Description |
|------|-------------|
| `set_presentation_metadata` | Set title and activate skills |
| `set_theme` | Configure colors, fonts, sizes |
| `add_slide` | Add slide (title/content/section/two-column/comparison/chart/image) |
| `list_slides` | Review current slide deck |
| `remove_slide` | Remove a slide by number |
| `export_pptx` | Generate the .pptx file |

## Example

```
You: Create a 10-slide presentation about cloud-native architecture for CTOs
Assistant: [calls set_presentation_metadata, set_theme, add_slide x10, export_pptx]
         → output/Cloud_Native_Architecture.pptx (10 slides)
```

Output files are saved to `./output/` by default.
