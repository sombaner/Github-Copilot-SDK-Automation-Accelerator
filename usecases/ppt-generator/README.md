# PPT Generator Use Case

AI-powered PowerPoint presentation generator built with the GitHub Copilot SDK.

Uses **Claude Opus 4.6** to understand prompts, apply agent skills, invoke custom tools, and produce polished `.pptx` files.

## How It Works

```
User Prompt + Agent Skills
        │
        ▼
┌─────────────────────────────┐
│   Copilot SDK Agent         │
│   (Claude Opus 4.6)         │
│                             │
│   System prompt includes:   │
│   - Presentation expertise  │
│   - Active skill directives │
│                             │
│   Custom Tools:             │
│   ├─ set_presentation_metadata │
│   ├─ set_theme              │
│   ├─ add_slide              │
│   ├─ list_slides            │
│   ├─ remove_slide           │
│   └─ export_pptx            │
└─────────────┬───────────────┘
              │
              ▼
        .pptx file
```

## Features

- **Agent Skills as Input**: Pass skills like `concise`, `technical`, `storytelling`, `data-driven`, `executive-summary`, or `creative` to shape the content style
- **Multiple Slide Layouts**: title, content, section, two-column, comparison, chart, image
- **Theming**: Customize colors, fonts, and sizes
- **Charts**: Auto-generate bar/column charts from data
- **Speaker Notes**: Every slide gets speaker notes
- **Interactive CLI**: Multi-turn conversation to refine the presentation

## Implementations

| Language | Path | Status |
|----------|------|--------|
| **Node.js** | [nodejs/](nodejs/) | ✅ Complete |
| **Python** | [python/](python/) | ✅ Complete |
| **Go** | go/ | 🔧 Coming soon |
| **.NET** | dotnet/ | 🔧 Coming soon |

## Quick Start

### Node.js

```bash
cd nodejs && npm install
npx tsx ppt-generator-agent.ts
# With skills:
npx tsx ppt-generator-agent.ts --skills="concise,data-driven"
```

### Python

```bash
cd python && pip install -r requirements.txt
python ppt_generator_agent.py
# With skills:
python ppt_generator_agent.py --skills="storytelling,creative"
```

## Example Prompts

- "Create a 10-slide presentation about cloud-native architecture for CTOs"
- "Make a pitch deck for a SaaS startup that does AI-powered code review"
- "Build a technical deep-dive on Kubernetes security best practices"
- "Generate a quarterly business review with revenue charts"

## Custom Tools Reference

| Tool | Purpose |
|------|---------|
| `set_presentation_metadata` | Initialize title & activate skills |
| `set_theme` | Set colors, fonts, sizes for the whole deck |
| `add_slide` | Add a slide with a specific layout |
| `list_slides` | Review the current deck before export |
| `remove_slide` | Delete a slide by number |
| `export_pptx` | Render and save the .pptx file |

## Slide Layouts

| Layout | Best For |
|--------|----------|
| `title` | Opening slide with big centered title |
| `content` | Standard bullets or body text |
| `section` | Section divider between topics |
| `two-column` | Side-by-side information |
| `comparison` | Comparing two options/approaches |
| `chart` | Numerical data visualization |
| `image` | Visual/image-focused slides |
