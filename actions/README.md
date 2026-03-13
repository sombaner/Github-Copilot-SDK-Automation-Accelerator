# GitHub Actions Workflows

Reusable GitHub Actions workflows for running Copilot SDK agents in CI/CD pipelines.

## Available Workflows

| Workflow | Description |
|----------|-------------|
| [copilot-sdk-action.yml](copilot-sdk-action.yml) | General-purpose reusable workflow for any use case |
| [aks-monitor.yml](aks-monitor.yml) | AKS cluster monitoring workflow |
| [council-query.yml](council-query.yml) | Use a LLM council to act uppon your codebase |
| [feature-requirement.yml](feature-requirement-analysis.yml) | Analyse feature completeness using a LLM Council |
| [gatekeeper.yml](gatekeeper.yml) | Analyse the PR for techncial readiness, feature drift, production readiness, unit test coverage all using a LLM COuncil |
| [cast-feature-impact.yml](cast-feature-impact.yml) | Leverage CAST software to do a determinsitc analysis of a features impact for larger codebases with multi-application dependencies - using the cast MCP server |

## Quick Start

### Run AKS Monitor Agent

```yaml
# .github/workflows/aks-monitor.yml
name: AKS Monitoring
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

jobs:
  monitor:
    uses: ./.github/workflows/copilot-sdk-action.yml
    with:
      usecase: monitoring
      language: nodejs
    secrets:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Run Council Query

The core building block — runs a 3-stage LLM council (individual responses → peer ranking → chairman synthesis) against your codebase for any free-text question. Can be triggered manually or called as a reusable workflow by other pipelines.

> **Important:** `council-query.yml` **must** exist at `.github/workflows/council-query.yml` in your repository. It is a **required dependency** for both `feature-requirement-analysis.yml` and `gatekeeper.yml`, which call it via `uses: ./.github/workflows/council-query.yml`.

```yaml
# .github/workflows/council-query.yml
name: Council Query
on:
  workflow_dispatch:
    inputs:
      query:
        description: 'Your question about the codebase'
        required: true
        type: string

jobs:
  council:
    uses: ./.github/workflows/council-query.yml
    with:
      query: ${{ inputs.query }}
    secrets: inherit
```

> **Required secret:** `COPILOT_GITHUB_TOKEN` — a GitHub token with Copilot CLI access.
>
> Trigger via the Actions tab, type your question, and the council (gpt-4.1, claude-sonnet-4, gpt-5-mini) will independently answer, rank each other, and a chairman model synthesises the final response. Results are available in the Step Summary and as a downloadable artifact.

### Run Feature Requirement Analysis

Triggered when an issue is labelled `gate-keeper`. It runs an LLM Council to evaluate whether the issue is detailed enough for a developer to start work — checking requirement clarity, codebase impact, test scenario completeness, and producing a Developer Readiness Score. If `CAST_IMAGING_API_KEY` is configured, a CAST impact analysis runs in parallel.

```yaml
# .github/workflows/feature-requirement-analysis.yml
name: Feature Requirement Analysis
on:
  issues:
    types: [labeled]

jobs:
  analyse:
    uses: ./.github/workflows/feature-requirement-analysis.yml
    secrets: inherit
```

> **Label trigger:** Add the `gate-keeper` label to any issue to kick off the analysis.
>
> **Optional CAST integration:** Set the `CAST_IMAGING_API_KEY` secret to also get a deterministic architectural impact report from CAST Imaging.

### Run Gatekeeper (PR Quality Gate)

Runs automatically on every Pull Request (open, synchronise, reopen). It spins up four parallel LLM Council analyses — requirement drift, technical excellence, unit test coverage — then aggregates them into a final **GO / NO-GO production readiness verdict**.

```yaml
# .github/workflows/gatekeeper.yml
name: Gatekeeper Analysis
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  gatekeeper:
    uses: ./.github/workflows/gatekeeper.yml
    permissions:
      issues: read
      pull-requests: read
    secrets: inherit
```

> The workflow automatically extracts PR context (description, changed files, comments) and detects linked issues (`Fixes #N`, `Closes #N`, `Resolves #N`). All four council reports are bundled into a single downloadable artifact.

### Run CAST Feature Impact Analysis

Connects to CAST Imaging via its MCP server to produce an architecture-level complexity and impact estimate for a proposed feature. Can auto-discover the target application or accept one explicitly.

```yaml
# .github/workflows/cast-feature-impact.yml
name: CAST Feature Impact Analysis
on:
  workflow_dispatch:
    inputs:
      feature_description:
        description: 'Describe the feature to analyse'
        required: true
        type: string
      application_name:
        description: 'CAST application name (leave empty to auto-discover)'
        required: false
        type: string
        default: ''

jobs:
  impact:
    uses: ./.github/workflows/cast-feature-impact.yml
    with:
      feature_description: ${{ inputs.feature_description }}
      application_name: ${{ inputs.application_name }}
    secrets: inherit
```

> **Required secret:** `CAST_IMAGING_API_KEY` — your CAST Imaging API key.
>
> **Required secret:** `COPILOT_GITHUB_TOKEN` — a GitHub token with Copilot CLI access.
>
> Trigger manually via the Actions tab or call it as a reusable workflow from another pipeline.

### Run Any Use Case

```yaml
name: Custom Agent
on: [workflow_dispatch]

jobs:
  run:
    uses: ./.github/workflows/copilot-sdk-action.yml
    with:
      usecase: code-review
      language: nodejs
      prompt: "Review the latest changes for security issues"
    secrets:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Prerequisites for Council-based Workflows

The **council-query**, **feature-requirement-analysis**, **gatekeeper**, and **cast-feature-impact** workflows rely on shared resources that must be present in your repository:

| Requirement | Path | Purpose |
|-------------|------|---------|
| Council Query workflow | `.github/workflows/council-query.yml` | Reusable workflow called by `feature-requirement-analysis.yml` and `gatekeeper.yml` via `uses:` |
| Scripts folder | `actions/scripts/` | Python modules used by the council and result-fetching pipelines |

### `actions/scripts/` contents

| File | Role |
|------|------|
| `config.py` | Council model list (`gpt-4.1`, `claude-sonnet-4`, `gpt-5-mini`) and chairman model configuration |
| `copilot_client.py` | GitHub Copilot SDK client — manages sessions and parallel model queries |
| `council.py` | 3-stage council orchestration (collect → rank → chairman synthesis) |
| `council_ci_runner.py` | CI entry-point that runs the council end-to-end and writes results |
| `fetch-council-results.py` | CLI tool to download and display council results from a workflow run (`python scripts/fetch-council-results.py --latest`) |

Make sure to copy both `council-query.yml` into `.github/workflows/` **and** the `actions/scripts/` folder into your repository.

## Required Permissions

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: write
```

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub token for Copilot SDK authentication |
| `COPILOT_GITHUB_TOKEN` | For council & CAST workflows | GitHub token with Copilot CLI access |
| `CAST_IMAGING_API_KEY` | For CAST workflows | CAST Imaging API key for architecture analysis |
| `AZURE_TENANT_ID` | For Azure agents | Azure Active Directory tenant ID |
| `AZURE_SUBSCRIPTION_ID` | For Azure agents | Azure subscription ID |
| `AZURE_CLIENT_ID` | For Azure agents | Azure service principal client ID |
| `AZURE_CLIENT_SECRET` | For Azure agents | Azure service principal secret |

## Related

- [Main README](../README.md) — Project overview
- [Automation Scripts](../automation/README.md) — Local runner scripts
- [Use Cases](../usecases/README.md) — Available use cases
