# Review Agent Sample Pack

This sample pack gives you a self-contained review request that works with the Node.js review agent.

Files included:

- `catalog-service/docs/architecture/catalog-search-design.md`
- `catalog-service/src/catalog/search.ts`
- `catalog-service/tests/catalog/search.test.ts`
- `../prompts/sample-end-to-end-review.md`

Why the prompt embeds file snapshots:

- The current review agent attaches the prompt file to the Copilot SDK session.
- The agent can fetch external guidance through GitHub MCP-backed spaces.
- The changed source files are not attached automatically, so this sample prompt includes inline snapshots of the changed files to make the review runnable before opening a real PR.

Run locally:

```bash
cd usecases/review/nodejs
npm install
npx tsx review-agent.ts --prompt-file ../prompts/sample-end-to-end-review.md --output-file ../samples/catalog-service/review-report.md
```

Optional model overrides:

```bash
REVIEW_MODEL_ARCHITECTURE=gpt-5.4 \
REVIEW_MODEL_CODE=claude-opus-4.6 \
npx tsx review-agent.ts --prompt-file ../prompts/sample-end-to-end-review.md
```