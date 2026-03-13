# PPT Generator Agent — Python

AI-powered PowerPoint presentation generator built with the GitHub Copilot SDK and Claude Opus 4.6.

## Quick Start

```bash
pip install -r requirements.txt
python ppt_generator_agent.py
```

## With Agent Skills

```bash
python ppt_generator_agent.py --skills="concise,data-driven"
python ppt_generator_agent.py --skills="storytelling,creative"
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

Output files are saved to `./output/` by default.
