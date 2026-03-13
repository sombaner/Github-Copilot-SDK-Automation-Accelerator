#!/usr/bin/env bash
# =============================================================================
# Copilot Governance Scanner
# Scans prompts, tool inputs, and outputs for sensitive data, threats, and
# policy violations. Provides governance controls with configurable levels.
#
# Usage: Called by Copilot hooks via stdin JSON.
#        EVENT_TYPE env var determines which hook event triggered this script.
#
# Governance Levels:
#   open     - Audit only, never block
#   standard - Block high severity, warn medium, audit low
#   strict   - Block high+medium, warn low
#   locked   - Block all threats
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/governance-config.json"
PATTERNS_FILE="${SCRIPT_DIR}/patterns.json"
AUDIT_DIR="${SCRIPT_DIR}/../audit"
AUDIT_LOG="${AUDIT_DIR}/governance-audit.jsonl"
SESSION_SUMMARY="${AUDIT_DIR}/session-summary.json"

# Ensure audit directory exists
mkdir -p "${AUDIT_DIR}"

# -----------------------------------------------------------------------------
# Utility: Read JSON values (lightweight, no jq dependency fallback)
# -----------------------------------------------------------------------------
read_json_value() {
  local file="$1" key="$2"
  if command -v jq &>/dev/null; then
    jq -r "$key" "$file" 2>/dev/null || echo ""
  else
    # Fallback: python3 json
    python3 -c "
import json, sys
with open('$file') as f:
    data = json.load(f)
keys = '$key'.strip('.').split('.')
val = data
for k in keys:
    if isinstance(val, dict) and k in val:
        val = val[k]
    else:
        val = ''
        break
print(val if isinstance(val, str) else json.dumps(val))
" 2>/dev/null || echo ""
  fi
}

# -----------------------------------------------------------------------------
# Load governance level
# -----------------------------------------------------------------------------
GOVERNANCE_LEVEL=$(read_json_value "${CONFIG_FILE}" ".governanceLevel")
if [[ -z "${GOVERNANCE_LEVEL}" ]]; then
  GOVERNANCE_LEVEL="standard"
fi

# -----------------------------------------------------------------------------
# Read hook input from stdin
# -----------------------------------------------------------------------------
HOOK_INPUT=$(cat)
EVENT_TYPE="${EVENT_TYPE:-unknown}"

# -----------------------------------------------------------------------------
# Extract text to scan based on event type
# -----------------------------------------------------------------------------
extract_scan_text() {
  if command -v jq &>/dev/null; then
    case "${EVENT_TYPE}" in
      UserPromptSubmit)
        echo "${HOOK_INPUT}" | jq -r '.userPrompt // empty' 2>/dev/null
        ;;
      PreToolUse)
        echo "${HOOK_INPUT}" | jq -r '(.toolName // "") + " " + (.toolInput // "" | tostring)' 2>/dev/null
        ;;
      PostToolUse)
        echo "${HOOK_INPUT}" | jq -r '(.toolName // "") + " " + (.toolOutput // "" | tostring)' 2>/dev/null
        ;;
      SessionStart)
        echo "SESSION_START"
        ;;
      Stop)
        echo "SESSION_STOP"
        ;;
      *)
        echo "${HOOK_INPUT}" | jq -r 'tostring' 2>/dev/null
        ;;
    esac
  else
    python3 -c "
import json, sys
data = json.loads('''${HOOK_INPUT}''')
event = '${EVENT_TYPE}'
if event == 'UserPromptSubmit':
    print(data.get('userPrompt', ''))
elif event == 'PreToolUse':
    print(str(data.get('toolName', '')) + ' ' + str(data.get('toolInput', '')))
elif event == 'PostToolUse':
    print(str(data.get('toolName', '')) + ' ' + str(data.get('toolOutput', '')))
elif event in ('SessionStart', 'Stop'):
    print('SESSION_' + event.upper())
else:
    print(json.dumps(data))
" 2>/dev/null || echo "${HOOK_INPUT}"
  fi
}

# -----------------------------------------------------------------------------
# Scan text against patterns using python3 for reliable regex
# -----------------------------------------------------------------------------
scan_for_threats() {
  local text="$1"
  python3 << 'PYTHON_SCANNER' - "${text}" "${PATTERNS_FILE}" "${CONFIG_FILE}" "${GOVERNANCE_LEVEL}"
import json
import re
import sys
import os

text = sys.argv[1]
patterns_file = sys.argv[2]
config_file = sys.argv[3]
governance_level = sys.argv[4]

with open(patterns_file) as f:
    patterns = json.load(f)

with open(config_file) as f:
    config = json.load(f)

level_config = config.get("levels", {}).get(governance_level, config["levels"]["standard"])

findings = []

for category, subcategories in patterns.items():
    for subcat_name, subcat_data in subcategories.items():
        if not isinstance(subcat_data, dict) or "patterns" not in subcat_data:
            continue

        severity = subcat_data.get("severity", "medium")

        # Check context hints if available (reduces false positives for numeric patterns)
        context_hints = subcat_data.get("contextHints", [])
        if context_hints:
            has_context = any(hint.lower() in text.lower() for hint in context_hints)
            if not has_context and category == "sensitive_data_exposure" and subcat_name in ("ssn", "aadhaar"):
                continue

        for pattern in subcat_data["patterns"]:
            try:
                matches = re.findall(pattern, text)
                if matches:
                    # Redact matched content for audit (show first/last 2 chars only)
                    redacted = []
                    for m in matches[:3]:  # Cap at 3 matches per pattern
                        match_str = m if isinstance(m, str) else str(m)
                        if len(match_str) > 6:
                            redacted.append(match_str[:2] + "*" * (len(match_str) - 4) + match_str[-2:])
                        else:
                            redacted.append("*" * len(match_str))

                    findings.append({
                        "category": category,
                        "subcategory": subcat_name,
                        "description": subcat_data.get("description", ""),
                        "severity": severity,
                        "matchCount": len(matches),
                        "redactedSamples": redacted,
                        "pattern": pattern[:50] + "..." if len(pattern) > 50 else pattern
                    })
            except re.error:
                continue

# Determine action for each finding based on governance level
severity_action_key = {
    "high": "highSeverity",
    "medium": "mediumSeverity",
    "low": "lowSeverity"
}

for finding in findings:
    action_key = severity_action_key.get(finding["severity"], "mediumSeverity")
    finding["action"] = level_config.get(action_key, "audit")

# Output findings as JSON
print(json.dumps(findings))
PYTHON_SCANNER
}

# -----------------------------------------------------------------------------
# Write audit log entry (append-only JSONL)
# -----------------------------------------------------------------------------
write_audit_log() {
  local event="$1" findings="$2" action_taken="$3"

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local tool_name=""
  if command -v jq &>/dev/null; then
    tool_name=$(echo "${HOOK_INPUT}" | jq -r '.toolName // ""' 2>/dev/null)
  fi

  python3 << AUDIT_WRITER - "${timestamp}" "${event}" "${findings}" "${action_taken}" "${GOVERNANCE_LEVEL}" "${tool_name}"
import json
import sys
import os

timestamp = sys.argv[1]
event = sys.argv[2]
findings_json = sys.argv[3]
action_taken = sys.argv[4]
gov_level = sys.argv[5]
tool_name = sys.argv[6]

try:
    findings = json.loads(findings_json) if findings_json else []
except json.JSONDecodeError:
    findings = []

entry = {
    "timestamp": timestamp,
    "event": event,
    "governanceLevel": gov_level,
    "toolName": tool_name,
    "actionTaken": action_taken,
    "findingCount": len(findings),
    "findings": findings
}

audit_log = os.environ.get("AUDIT_LOG", "${AUDIT_LOG}")
with open(audit_log, "a") as f:
    f.write(json.dumps(entry) + "\n")
AUDIT_WRITER
}

# -----------------------------------------------------------------------------
# Generate session summary from audit log
# -----------------------------------------------------------------------------
generate_session_summary() {
  python3 << 'SUMMARY_GEN' - "${AUDIT_LOG}" "${SESSION_SUMMARY}" "${GOVERNANCE_LEVEL}"
import json
import sys
import os
from collections import defaultdict

audit_log = sys.argv[1]
summary_file = sys.argv[2]
gov_level = sys.argv[3]

if not os.path.exists(audit_log):
    print(json.dumps({"message": "No audit events recorded this session."}))
    sys.exit(0)

total_events = 0
total_findings = 0
blocked = 0
warned = 0
audited = 0
by_category = defaultdict(int)
by_severity = defaultdict(int)
by_action = defaultdict(int)
threat_timeline = []

with open(audit_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            total_events += 1
            findings = entry.get("findings", [])
            total_findings += len(findings)

            for finding in findings:
                cat = finding.get("category", "unknown")
                sev = finding.get("severity", "unknown")
                act = finding.get("action", "audit")
                by_category[cat] += 1
                by_severity[sev] += 1
                by_action[act] += 1

            action = entry.get("actionTaken", "audit")
            if action == "deny":
                blocked += 1
            elif action == "ask":
                warned += 1
            else:
                audited += 1

            if findings:
                threat_timeline.append({
                    "timestamp": entry.get("timestamp"),
                    "event": entry.get("event"),
                    "toolName": entry.get("toolName", ""),
                    "categoriesDetected": list(set(f.get("category") for f in findings)),
                    "maxSeverity": max((f.get("severity", "low") for f in findings),
                                       key=lambda s: {"high": 3, "medium": 2, "low": 1}.get(s, 0))
                })
        except json.JSONDecodeError:
            continue

summary = {
    "governanceLevel": gov_level,
    "totalEvents": total_events,
    "totalFindings": total_findings,
    "actions": {
        "blocked": blocked,
        "warned": warned,
        "audited": audited
    },
    "findingsByCategory": dict(by_category),
    "findingsBySeverity": dict(by_severity),
    "findingsByAction": dict(by_action),
    "threatTimeline": threat_timeline[-20:]  # Last 20 events
}

with open(summary_file, "w") as f:
    json.dump(summary, f, indent=2)

print(json.dumps(summary, indent=2))
SUMMARY_GEN
}

# -----------------------------------------------------------------------------
# Handle SessionStart: Initialize audit log and report config
# -----------------------------------------------------------------------------
handle_session_start() {
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Write session start marker to audit log
  python3 -c "
import json
entry = {
    'timestamp': '${timestamp}',
    'event': 'SessionStart',
    'governanceLevel': '${GOVERNANCE_LEVEL}',
    'toolName': '',
    'actionTaken': 'audit',
    'findingCount': 0,
    'findings': [],
    'message': 'Governance scanner initialized. Level: ${GOVERNANCE_LEVEL}'
}
with open('${AUDIT_LOG}', 'a') as f:
    f.write(json.dumps(entry) + '\n')
"

  # Return context injection message
  cat << EOF
{
  "systemMessage": "🛡️ Governance Scanner Active\\n\\nLevel: ${GOVERNANCE_LEVEL}\\nThreat detection enabled for: sensitive data exposure, credential exposure, data exfiltration, privilege escalation, system destruction, prompt injection.\\nAll events are logged to the audit trail.\\n\\nGovernance actions by level:\\n- open: audit-only\\n- standard: block high, warn medium, audit low\\n- strict: block high+medium, warn low\\n- locked: block all threats"
}
EOF
}

# -----------------------------------------------------------------------------
# Handle Stop: Generate and output session summary
# -----------------------------------------------------------------------------
handle_session_stop() {
  local summary
  summary=$(generate_session_summary)

  write_audit_log "Stop" "[]" "audit"

  cat << EOF
{
  "systemMessage": "🛡️ Governance Session Summary\\n${summary}"
}
EOF
}

# -----------------------------------------------------------------------------
# Build hook response based on findings and governance level
# -----------------------------------------------------------------------------
build_response() {
  local findings="$1"
  local finding_count
  finding_count=$(echo "${findings}" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "0")

  if [[ "${finding_count}" == "0" ]]; then
    write_audit_log "${EVENT_TYPE}" "[]" "allow"
    echo '{"continue": true}'
    return 0
  fi

  # Determine the most severe action needed
  local max_action
  max_action=$(echo "${findings}" | python3 -c "
import json, sys
findings = json.loads(sys.stdin.read())
actions = [f.get('action', 'audit') for f in findings]
priority = {'deny': 3, 'ask': 2, 'audit': 1}
max_act = max(actions, key=lambda a: priority.get(a, 0))
print(max_act)
" 2>/dev/null || echo "audit")

  # Build human-readable reason
  local reason
  reason=$(echo "${findings}" | python3 -c "
import json, sys
findings = json.loads(sys.stdin.read())
lines = []
for f in findings:
    icon = '🔴' if f['severity'] == 'high' else ('🟡' if f['severity'] == 'medium' else '🟢')
    action_str = f.get('action', 'audit').upper()
    lines.append(f\"{icon} [{action_str}] {f['category']}/{f['subcategory']}: {f['description']} ({f['matchCount']} match(es))\")
print('\\n'.join(lines))
" 2>/dev/null || echo "Threat detected")

  write_audit_log "${EVENT_TYPE}" "${findings}" "${max_action}"

  case "${max_action}" in
    deny)
      if [[ "${EVENT_TYPE}" == "PreToolUse" ]]; then
        cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "🛡️ GOVERNANCE BLOCK (${GOVERNANCE_LEVEL})\\n\\n${reason}"
  }
}
EOF
      else
        cat << EOF
{
  "continue": false,
  "stopReason": "🛡️ GOVERNANCE BLOCK (${GOVERNANCE_LEVEL})\\n\\n${reason}"
}
EOF
      fi
      exit 2
      ;;
    ask)
      if [[ "${EVENT_TYPE}" == "PreToolUse" ]]; then
        cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "🛡️ GOVERNANCE WARNING (${GOVERNANCE_LEVEL})\\n\\n${reason}"
  }
}
EOF
      else
        cat << EOF
{
  "systemMessage": "🛡️ GOVERNANCE WARNING (${GOVERNANCE_LEVEL})\\n\\n${reason}"
}
EOF
      fi
      ;;
    audit|*)
      cat << EOF
{
  "systemMessage": "🛡️ GOVERNANCE AUDIT (${GOVERNANCE_LEVEL})\\n\\n${reason}"
}
EOF
      ;;
  esac
}

# =============================================================================
# Main
# =============================================================================
main() {
  case "${EVENT_TYPE}" in
    SessionStart)
      handle_session_start
      exit 0
      ;;
    Stop)
      handle_session_stop
      exit 0
      ;;
    UserPromptSubmit|PreToolUse|PostToolUse)
      local scan_text
      scan_text=$(extract_scan_text)

      if [[ -z "${scan_text}" || "${scan_text}" == "null" ]]; then
        echo '{"continue": true}'
        exit 0
      fi

      local findings
      findings=$(scan_for_threats "${scan_text}")
      build_response "${findings}"
      ;;
    *)
      echo '{"continue": true}'
      exit 0
      ;;
  esac
}

main
