<!-- review-config
{
  "review_types": ["architecture", "code"],
  "pull_request": {
    "number": 123,
    "title": "Introduce service architecture and implementation",
    "url": "https://github.com/example/repo/pull/123",
    "base_ref": "main",
    "head_ref": "feature/review-agent"
  },
  "github_spaces": [
    {
      "name": "platform-architecture",
      "owner": "example",
      "repo": "review-guidance",
      "ref": "main",
      "review_types": ["architecture", "design"],
      "instructions": ["spaces/architecture/instructions.md"],
      "context": ["spaces/shared/principles.md", "spaces/shared/non-functional-requirements.md"]
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
    { "path": "docs/architecture/review-agent.md", "kind": "architecture" },
    { "path": "src/review/agent.ts", "kind": "code" },
    { "path": "tests/review/agent.test.ts", "kind": "unit-test" }
  ],
  "instructions": [
    "Review the markdown architecture proposal before reviewing code.",
    "Check whether the implementation and tests match the proposal.",
    "Use GitHub Spaces from the external guidance repository for standards."
  ]
}
-->

# Review Request

Review the proposed review-agent design and the implementation.

## Expectations

- Confirm the architecture markdown explains model routing, task splitting, and GitHub MCP usage clearly.
- Confirm the implementation mirrors the documented design.
- Confirm unit tests cover routing and prompt parsing behavior.

## Notes

- Treat the markdown file as the source of truth for selecting review mode and GitHub Spaces.
- If both architecture/design and code are present, produce separate sections for each review stream.