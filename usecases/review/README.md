# Review Use Case

Generic review agent built with the GitHub Copilot SDK.

The agent accepts a markdown prompt file, classifies the request into architecture/design review and code/unit-test review, loads external review guidance through GitHub MCP-backed "GitHub Spaces", and routes each review task to the configured model.

## Review Modes

- Architecture review
- Design review
- Code review

Architecture and design review run on `gpt-5.4` by default.
Code and unit-test review run on `claude-opus-4.6` by default.

Override either model with:

- `REVIEW_MODEL_ARCHITECTURE`
- `REVIEW_MODEL_CODE`

## Prompt Contract

Every invocation passes a markdown file. The markdown can include a JSON configuration block inside an HTML comment.

```md
<!-- review-config
{
  "review_types": ["architecture", "code"],
  "pull_request": {
    "number": 42,
    "title": "Add ADR and API implementation",
    "url": "https://github.com/example/repo/pull/42",
    "base_ref": "main",
    "head_ref": "feature/review"
  },
  "github_spaces": [
    {
      "name": "platform-architecture",
      "owner": "example",
      "repo": "review-guidance",
      "ref": "main",
      "review_types": ["architecture", "design"],
      "instructions": ["spaces/architecture/instructions.md"],
      "context": ["spaces/shared/principles.md"]
    },
    {
      "name": "engineering-code-review",
      "owner": "example",
      "repo": "review-guidance",
      "ref": "main",
      "review_types": ["code"],
      "instructions": ["spaces/code/instructions.md"],
      "context": ["spaces/code/testing.md", "spaces/code/security.md"]
    }
  ],
  "changed_files": [
    { "path": "docs/architecture/service-adr.md", "kind": "architecture" },
    { "path": "src/api/review.ts", "kind": "code" },
    { "path": "tests/review.test.ts", "kind": "unit-test" }
  ],
  "instructions": [
    "Use the declared GitHub Spaces before reviewing.",
    "Focus on compatibility and missing tests."
  ]
}
-->

# Review Request

Explain what the reviewer should look for.
```

The agent exposes two custom tools for the space catalog:

- `list_github_spaces`
- `get_github_space`

The agent uses those tools to decide which space to load, then uses the GitHub MCP server to fetch the actual external markdown files from the configured repository and ref.

## Implementation

| Language | Path | Status |
|----------|------|--------|
| Node.js | [nodejs/](nodejs/) | Complete |

## Quick Start

```bash
cd usecases/review/nodejs
npm install
npx tsx review-agent.ts --prompt-file ../prompts/sample-review-request.md
```

## GitHub Spaces

This accelerator models a GitHub Space as a prompt-declared external review context pack:

- `owner` and `repo` identify the external repository.
- `ref` pins the version.
- `instructions` lists markdown files that define the review prompt for that space.
- `context` lists supporting markdown files to fetch with GitHub MCP.

This keeps the review contract explicit and keeps the runtime focused on the Node.js implementation without hard-coding repository-specific logic.