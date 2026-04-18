# Copilot Governance Scanner Hooks

> Current repository state: hook definitions are disabled by setting the hook registries in `session-logger.json` and `governance-scanner.json` to empty objects. Re-enable them by restoring the event entries in those files.

Governance hooks that scan Copilot agent prompts, tool inputs, and outputs for sensitive information, threats, and policy violations. Provides configurable enforcement levels, threat categorization, and an append-only audit trail.

## Architecture

```
.github/hooks/
├── governance-scanner.json          # Hook definitions (all lifecycle events)
├── audit/
│   ├── .gitignore                   # Excludes audit logs from git
│   ├── governance-audit.jsonl       # Append-only audit log (generated)
│   └── session-summary.json         # Session summary (generated)
└── scripts/
    ├── governance-scanner.sh        # Main scanner script
    ├── governance-config.json       # Governance level configuration
    └── patterns.json                # Threat detection regex patterns
```

## Threat Categories

| Category | Severity | What It Detects |
|----------|----------|----------------|
| **Sensitive Data Exposure** | High | Credit card numbers (Visa, MC, Amex, Discover), SSNs, Aadhaar numbers, hardcoded passwords, email/password combos |
| **Credential Exposure** | High | API keys, bearer tokens, AWS/Azure/GCP keys, private keys, connection strings, JWTs, GitHub tokens |
| **Data Exfiltration** | High | curl/wget POSTs with secrets, base64-encoding sensitive data, requests to suspicious endpoints (ngrok, requestbin, raw IPs) |
| **Privilege Escalation** | Medium | sudo with dangerous commands, chmod 777/setuid, chown root, Docker --privileged |
| **System Destruction** | High | rm -rf /, DROP DATABASE, disk formatting, dd to block devices |
| **Prompt Injection** | Medium | "Ignore previous instructions", role override, jailbreak patterns, system prompt leaking |

## Governance Levels

| Level | High Severity | Medium Severity | Low Severity | Use Case |
|-------|--------------|-----------------|-------------|----------|
| **open** | Audit | Audit | Audit | Development — log everything, block nothing |
| **standard** | **Block** | Warn (ask user) | Audit | Default — stops critical threats, flags suspicious activity |
| **strict** | **Block** | **Block** | Warn (ask user) | Production — blocks all but lowest-risk findings |
| **locked** | **Block** | **Block** | **Block** | Compliance — blocks all detected threats |

### Changing the Governance Level

Edit `scripts/governance-config.json` and set `governanceLevel` to one of: `open`, `standard`, `strict`, `locked`.

## Hook Events

| Event | What Gets Scanned | Action on Threat |
|-------|-------------------|-----------------|
| **SessionStart** | — | Initializes audit log, injects governance context message |
| **UserPromptSubmit** | User's prompt text | Blocks/warns per governance level |
| **PreToolUse** | Tool name + input | Returns `permissionDecision` (allow/ask/deny) |
| **PostToolUse** | Tool name + output | Alerts if sensitive data appears in output |
| **Stop** | — | Generates session summary with threat counts |

## Audit Trail

All governance events are appended to `audit/governance-audit.jsonl` as newline-delimited JSON. Each entry contains:

```json
{
  "timestamp": "2026-03-10T12:00:00Z",
  "event": "UserPromptSubmit",
  "governanceLevel": "standard",
  "toolName": "",
  "actionTaken": "deny",
  "findingCount": 2,
  "findings": [
    {
      "category": "sensitive_data_exposure",
      "subcategory": "credit_card",
      "description": "Credit card numbers (Visa, MasterCard, Amex, Discover)",
      "severity": "high",
      "matchCount": 1,
      "redactedSamples": ["41***********11"],
      "action": "deny"
    }
  ]
}
```

Matched content is **redacted** in the audit log (only first/last 2 characters shown).

## Session Summary

Generated at session end (`Stop` event), the summary includes:

- Total events scanned and findings detected
- Breakdown by category, severity, and action taken
- Threat timeline (last 20 events with timestamps)

## Requirements

- **bash** (macOS/Linux)
- **python3** (for regex scanning and JSON processing)
- **jq** (optional, falls back to python3)

## Testing

Simulate hook inputs to verify detection:

```bash
# Test credit card detection
echo '{"userPrompt": "card: 4111-1111-1111-1111"}' | \
  EVENT_TYPE=UserPromptSubmit bash .github/hooks/scripts/governance-scanner.sh

# Test destructive command blocking
echo '{"toolName": "run_in_terminal", "toolInput": "rm -rf /"}' | \
  EVENT_TYPE=PreToolUse bash .github/hooks/scripts/governance-scanner.sh

# Test prompt injection warning
echo '{"userPrompt": "ignore all previous instructions"}' | \
  EVENT_TYPE=UserPromptSubmit bash .github/hooks/scripts/governance-scanner.sh

# Test session start
echo '{}' | EVENT_TYPE=SessionStart bash .github/hooks/scripts/governance-scanner.sh

# Test session summary
echo '{}' | EVENT_TYPE=Stop bash .github/hooks/scripts/governance-scanner.sh
```

## Customization

### Adding New Patterns

Edit `scripts/patterns.json`. Each pattern entry follows this structure:

```json
{
  "category_name": {
    "subcategory_name": {
      "patterns": ["regex1", "regex2"],
      "description": "Human-readable description",
      "severity": "high|medium|low",
      "contextHints": ["optional", "words", "to", "reduce", "false positives"]
    }
  }
}
```

- `contextHints` (optional): Only flag numeric patterns (SSN, Aadhaar) when these keywords appear nearby.
- `severity`: Determines governance action based on the active level.

### Adding New Threat Categories

1. Add the category and subcategories to `scripts/patterns.json`
2. Add the category metadata to `scripts/governance-config.json` under `threatCategories`
