#!/usr/bin/env bash
# =============================================================================
# Copilot Session Logger
# Logs all Copilot agent session activity for audit and analysis.
#
# Captures every lifecycle event — session start/stop, user prompts, tool
# invocations (pre/post), subagent activity, and context compaction — into
# an append-only JSONL log with structured metadata.
#
# Usage: Called by Copilot hooks via stdin JSON.
#        EVENT_TYPE env var determines which hook event triggered this script.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/../audit"
SESSION_LOG="${AUDIT_DIR}/session-activity.jsonl"
SESSION_METRICS="${AUDIT_DIR}/session-metrics.json"

mkdir -p "${AUDIT_DIR}"

EVENT_TYPE="${EVENT_TYPE:-unknown}"
HOOK_INPUT=$(cat)

# -----------------------------------------------------------------------------
# Write a structured log entry
# -----------------------------------------------------------------------------
write_log_entry() {
  python3 << 'PYLOG' - "${EVENT_TYPE}" "${HOOK_INPUT}" "${SESSION_LOG}"
import json
import sys
import os
import time
from datetime import datetime, timezone

event_type = sys.argv[1]
raw_input = sys.argv[2]
log_file = sys.argv[3]

try:
    hook_data = json.loads(raw_input) if raw_input.strip() else {}
except json.JSONDecodeError:
    hook_data = {"raw": raw_input[:500]}

timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

entry = {
    "timestamp": timestamp,
    "event": event_type,
}

# Extract event-specific fields
if event_type == "SessionStart":
    entry["detail"] = "Agent session started"
    entry["sessionId"] = hook_data.get("sessionId", "")

elif event_type == "UserPromptSubmit":
    prompt = hook_data.get("userPrompt", "")
    entry["detail"] = "User prompt submitted"
    entry["promptLength"] = len(prompt)
    # Log first 200 chars only (avoid logging sensitive content — governance scanner handles that)
    entry["promptPreview"] = (prompt[:200] + "...") if len(prompt) > 200 else prompt

elif event_type == "PreToolUse":
    tool_name = hook_data.get("toolName", "unknown")
    tool_input = hook_data.get("toolInput", "")
    entry["detail"] = f"Tool invocation requested: {tool_name}"
    entry["toolName"] = tool_name
    entry["inputLength"] = len(str(tool_input))
    # Summarize tool input without full content
    if isinstance(tool_input, dict):
        entry["inputKeys"] = list(tool_input.keys())[:10]
    elif isinstance(tool_input, str):
        entry["inputPreview"] = (tool_input[:150] + "...") if len(tool_input) > 150 else tool_input

elif event_type == "PostToolUse":
    tool_name = hook_data.get("toolName", "unknown")
    tool_output = hook_data.get("toolOutput", "")
    entry["detail"] = f"Tool execution completed: {tool_name}"
    entry["toolName"] = tool_name
    entry["outputLength"] = len(str(tool_output))
    entry["success"] = hook_data.get("success", True)

elif event_type == "PreCompact":
    entry["detail"] = "Context compaction triggered"
    entry["contextTokens"] = hook_data.get("contextTokens", 0)

elif event_type == "SubagentStart":
    entry["detail"] = "Subagent started"
    entry["subagentName"] = hook_data.get("agentName", "unknown")

elif event_type == "SubagentStop":
    entry["detail"] = "Subagent stopped"
    entry["subagentName"] = hook_data.get("agentName", "unknown")

elif event_type == "Stop":
    entry["detail"] = "Agent session ended"

else:
    entry["detail"] = f"Unknown event: {event_type}"

# Append to log
with open(log_file, "a") as f:
    f.write(json.dumps(entry) + "\n")

# Return continue (logger never blocks)
print(json.dumps({"continue": True}))
PYLOG
}

# -----------------------------------------------------------------------------
# Generate session metrics summary (called at Stop)
# -----------------------------------------------------------------------------
generate_metrics() {
  python3 << 'PYMETRICS' - "${SESSION_LOG}" "${SESSION_METRICS}"
import json
import sys
import os
from collections import defaultdict
from datetime import datetime

log_file = sys.argv[1]
metrics_file = sys.argv[2]

if not os.path.exists(log_file):
    summary = {"message": "No session activity recorded."}
    print(json.dumps(summary))
    sys.exit(0)

events = []
with open(log_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

if not events:
    summary = {"message": "No session activity recorded."}
    print(json.dumps(summary))
    sys.exit(0)

# Compute metrics
event_counts = defaultdict(int)
tool_usage = defaultdict(lambda: {"calls": 0, "totalInputBytes": 0, "totalOutputBytes": 0})
prompt_count = 0
total_prompt_chars = 0
session_start = None
session_end = None
subagents = set()
compactions = 0

for e in events:
    evt = e.get("event", "unknown")
    event_counts[evt] += 1
    ts = e.get("timestamp", "")

    if evt == "SessionStart" and not session_start:
        session_start = ts
    elif evt == "Stop":
        session_end = ts
    elif evt == "UserPromptSubmit":
        prompt_count += 1
        total_prompt_chars += e.get("promptLength", 0)
    elif evt == "PreToolUse":
        tool = e.get("toolName", "unknown")
        tool_usage[tool]["calls"] += 1
        tool_usage[tool]["totalInputBytes"] += e.get("inputLength", 0)
    elif evt == "PostToolUse":
        tool = e.get("toolName", "unknown")
        tool_usage[tool]["totalOutputBytes"] += e.get("outputLength", 0)
    elif evt == "PreCompact":
        compactions += 1
    elif evt in ("SubagentStart", "SubagentStop"):
        subagents.add(e.get("subagentName", "unknown"))

# Calculate duration
duration_seconds = None
if session_start and session_end:
    try:
        fmt = "%Y-%m-%dT%H:%M:%S.%fZ"
        t_start = datetime.strptime(session_start, fmt)
        t_end = datetime.strptime(session_end, fmt)
        duration_seconds = (t_end - t_start).total_seconds()
    except (ValueError, TypeError):
        pass

# Top tools by call count
top_tools = sorted(tool_usage.items(), key=lambda x: x[1]["calls"], reverse=True)[:10]

summary = {
    "sessionStart": session_start,
    "sessionEnd": session_end,
    "durationSeconds": duration_seconds,
    "totalEvents": len(events),
    "eventCounts": dict(event_counts),
    "promptCount": prompt_count,
    "totalPromptChars": total_prompt_chars,
    "avgPromptChars": round(total_prompt_chars / prompt_count) if prompt_count else 0,
    "uniqueToolsUsed": len(tool_usage),
    "totalToolCalls": sum(t["calls"] for t in tool_usage.values()),
    "topTools": {name: stats for name, stats in top_tools},
    "subagentsInvoked": sorted(list(subagents)),
    "contextCompactions": compactions,
}

with open(metrics_file, "w") as f:
    json.dump(summary, f, indent=2)

print(json.dumps(summary, indent=2))
PYMETRICS
}

# =============================================================================
# Main
# =============================================================================
main() {
  # Always log the event
  write_log_entry

  # On Stop, also generate the metrics summary
  if [[ "${EVENT_TYPE}" == "Stop" ]]; then
    local metrics
    metrics=$(generate_metrics)

    # Output session summary as system message
    cat << EOF
{
  "systemMessage": "📊 Session Activity Summary\\n${metrics}"
}
EOF
  fi
}

main
