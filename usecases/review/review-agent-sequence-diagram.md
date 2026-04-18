# Review Agent Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as review-agent.ts CLI
    participant FS as Local Filesystem
    participant Agent as Review Agent Runtime
    participant SDK as CopilotClient Session
    participant Tools as Custom Tools
    participant MCP as GitHub MCP Server
    participant GH as GitHub Repository Content

    User->>CLI: Run review agent with --prompt-file and optional --output-file
    CLI->>FS: Read prompt markdown file
    CLI->>FS: Read .github/copilot-instructions.md
    FS-->>CLI: Prompt content + default copilot instructions

    CLI->>Agent: Parse review-config block
    Agent->>Agent: Normalize changed_files
    Agent->>Agent: Normalize github_spaces
    Agent->>Agent: Build review tasks

    alt Architecture/design requested or inferred
        Agent->>Agent: Create Architecture and Design Review task
    end

    alt Code review requested or inferred
        Agent->>Agent: Create Code and Unit-Test Review task
    end

    CLI->>SDK: Start CopilotClient

    par For each review task
        Agent->>SDK: createSession(model, tools, mcpServers, systemMessage)
        Note over Agent,SDK: System message includes default copilot instructions loaded from .github/copilot-instructions.md
        Agent->>SDK: sendAndWait(prompt, attachment: prompt markdown)
        SDK->>Tools: list_review_tasks()
        Tools-->>SDK: Derived review streams and file list
        SDK->>Tools: list_github_spaces(reviewType?)
        Tools-->>SDK: Matching GitHub Spaces
        SDK->>Tools: get_github_space(name)
        Tools-->>SDK: repo, ref, instructions, context
        SDK->>MCP: Fetch declared instruction/context markdown files
        MCP->>GH: Read repo content at owner/repo@ref
        GH-->>MCP: Markdown guidance files
        MCP-->>SDK: External review guidance
        SDK->>SDK: Review prompt snapshot + GitHub Space guidance
        SDK-->>Agent: Review report for task
        Agent->>SDK: disconnect session
    and Parallel review task when both streams exist
        Agent->>SDK: createSession for second task
        SDK-->>Agent: Second review report
        Agent->>SDK: disconnect session
    end

    Agent->>Agent: Compose final report from all task outputs
    CLI->>FS: Write output report if --output-file provided
    CLI-->>User: Print combined review report to stdout
    CLI->>SDK: Stop CopilotClient

    Note over CLI,FS: If .github/copilot-instructions.md is missing, the agent falls back to its built-in default system message.
```

## Notes

- The prompt file is still the primary request contract for PR metadata, changed files, and GitHub Spaces.
- The agent now loads default review behavior from `.github/copilot-instructions.md` automatically.
- GitHub Spaces provide external review guidance through GitHub MCP and are applied per review stream.
- When both architecture/design and code review are inferred, the agent runs both tasks in parallel and merges the outputs into one report.