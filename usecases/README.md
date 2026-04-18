# Use Cases

This directory contains use-case-specific Copilot SDK agents organized by domain. Some use cases ship in multiple languages, while others are intentionally runtime-specific.

## Available Use Cases

| Use Case | Description | Primary Language |
|----------|-------------|-----------------|
| [monitoring/](monitoring/) | AKS cluster health monitoring, diagnostics, GitHub issue creation | Node.js |
| [review/](review/) | Generic architecture, design, and code review with GitHub Spaces and model routing | Node.js |
| [security-analysis/](security-analysis/) | Automated security vulnerability scanning | Node.js |
| [ppt-generator/](ppt-generator/) | AI-powered PowerPoint presentation generator with custom tools & agent skills | Node.js, Python |

## Structure

Typical structure:

```
<usecase>/
├── README.md         # Use case overview
├── nodejs/           # Node.js implementation
│   ├── package.json
│   ├── tsconfig.json
│   ├── <agent>.ts
│   └── README.md
├── python/           # Python implementation
│   ├── requirements.txt
│   ├── <agent>.py
│   └── README.md
├── go/               # Go implementation
│   ├── go.mod
│   ├── main.go
│   └── README.md
└── dotnet/           # .NET implementation
    ├── <Agent>.csproj
    ├── Program.cs
    └── README.md
```

## Running a Use Case

### Via CLI Runner

```bash
# From the repo root
./automation/copilot-sdk-runner.sh --usecase monitoring --lang nodejs
./automation/copilot-sdk-runner.sh --usecase review --lang nodejs --prompt-file usecases/review/prompts/sample-review-request.md
```

### Directly

```bash
# Node.js
cd usecases/monitoring/nodejs && npm install && npx tsx aks-monitor-agent.ts

# Review agent
cd usecases/review/nodejs && npm install && npx tsx review-agent.ts --prompt-file ../prompts/sample-review-request.md
```

## Adding a New Use Case

1. Create a new folder: `usecases/<your-usecase>/`
2. Add `README.md` describing the use case
3. Add at least one language implementation
4. Update the runner script in `automation/copilot-sdk-runner.sh`
5. Add CI/CD pipeline templates
6. Update this README
