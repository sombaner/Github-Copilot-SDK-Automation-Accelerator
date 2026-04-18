# Review Agent — Node.js

Generic review agent implemented with the GitHub Copilot SDK for Node.js.

## Run

```bash
npm install
npx tsx review-agent.ts --prompt-file ../prompts/sample-review-request.md
```

Optional flags:

- `--prompt-file <path>`
- `--output-file <path>`

Optional environment overrides:

- `REVIEW_MODEL_ARCHITECTURE`
- `REVIEW_MODEL_CODE`

The agent runs architecture/design review and code/unit-test review in parallel when both task types are present in the prompt file.