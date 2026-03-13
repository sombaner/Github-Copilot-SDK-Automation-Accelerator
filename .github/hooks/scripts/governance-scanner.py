#!/usr/bin/env python3
"""
Copilot Governance Scanner
==========================
Scans prompts, tool inputs/outputs, and file context for sensitive data,
credentials, threats, and policy violations. Blocks or warns based on
configurable governance levels.

Called by Copilot hooks — reads JSON from stdin, writes JSON to stdout.
Exit code 2 = blocking error (stops prompt from leaving IDE).

Governance Levels:
  open     - Audit only, never block
  standard - Block high severity, warn medium, audit low
  strict   - Block high+medium, warn low
  locked   - Block all threats
"""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "governance-config.json"
PATTERNS_FILE = SCRIPT_DIR / "patterns.json"
AUDIT_DIR = SCRIPT_DIR.parent / "audit"
AUDIT_LOG = AUDIT_DIR / "governance-audit.jsonl"
SESSION_SUMMARY = AUDIT_DIR / "session-summary.json"

AUDIT_DIR.mkdir(parents=True, exist_ok=True)

EVENT_TYPE = os.environ.get("EVENT_TYPE", "unknown")


# ---------------------------------------------------------------------------
# Load config + patterns
# ---------------------------------------------------------------------------
def load_json(path: Path) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        return {}


CONFIG = load_json(CONFIG_FILE)
PATTERNS = load_json(PATTERNS_FILE)
GOVERNANCE_LEVEL = CONFIG.get("governanceLevel", "standard")
LEVEL_CONFIG = CONFIG.get("levels", {}).get(
    GOVERNANCE_LEVEL, CONFIG.get("levels", {}).get("standard", {})
)


# ---------------------------------------------------------------------------
# Read hook input safely from stdin
# ---------------------------------------------------------------------------
def read_stdin() -> dict:
    try:
        raw = sys.stdin.read()
        if not raw or not raw.strip():
            return {}
        return json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return {}


# ---------------------------------------------------------------------------
# Extract ALL scannable text from the hook input
# ---------------------------------------------------------------------------
def extract_scan_text(hook_data: dict) -> str:
    """
    Extracts every piece of text that could contain sensitive info:
    - The user prompt itself
    - Any file content / context attached
    - Tool names, inputs, outputs
    - Any string value found recursively in the payload
    """
    parts: list[str] = []

    if EVENT_TYPE == "UserPromptSubmit":
        # Primary prompt text
        if "userPrompt" in hook_data:
            parts.append(str(hook_data["userPrompt"]))
        # Attached context / file contents (various possible field names)
        for key in ("context", "fileContext", "attachments", "references",
                     "codeContext", "selection", "activeFileContent"):
            if key in hook_data:
                parts.append(_flatten(hook_data[key]))

    elif EVENT_TYPE == "PreToolUse":
        if "toolName" in hook_data:
            parts.append(str(hook_data["toolName"]))
        if "toolInput" in hook_data:
            parts.append(_flatten(hook_data["toolInput"]))

    elif EVENT_TYPE == "PostToolUse":
        if "toolName" in hook_data:
            parts.append(str(hook_data["toolName"]))
        if "toolOutput" in hook_data:
            parts.append(_flatten(hook_data["toolOutput"]))

    # Fallback: if nothing extracted, dump everything
    if not parts:
        parts.append(_flatten(hook_data))

    return "\n".join(parts)


def _flatten(obj) -> str:
    """Recursively extract all string content from a nested structure."""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (int, float, bool)):
        return str(obj)
    if isinstance(obj, list):
        return "\n".join(_flatten(item) for item in obj)
    if isinstance(obj, dict):
        return "\n".join(_flatten(v) for v in obj.values())
    return str(obj) if obj is not None else ""


# ---------------------------------------------------------------------------
# Scan text against patterns
# ---------------------------------------------------------------------------
SEVERITY_ACTION_KEY = {
    "high": "highSeverity",
    "medium": "mediumSeverity",
    "low": "lowSeverity",
}


def scan_for_threats(text: str) -> list[dict]:
    if not text:
        return []

    findings = []

    for category, subcategories in PATTERNS.items():
        if not isinstance(subcategories, dict):
            continue
        for subcat_name, subcat_data in subcategories.items():
            if not isinstance(subcat_data, dict) or "patterns" not in subcat_data:
                continue

            severity = subcat_data.get("severity", "medium")

            # Context-hint gating to reduce false positives on numeric patterns
            context_hints = subcat_data.get("contextHints", [])
            if context_hints:
                has_context = any(h.lower() in text.lower() for h in context_hints)
                if not has_context and category == "sensitive_data_exposure" \
                        and subcat_name in ("ssn", "aadhaar"):
                    continue

            for pattern in subcat_data["patterns"]:
                try:
                    matches = re.findall(pattern, text, re.IGNORECASE)
                except re.error:
                    continue
                if not matches:
                    continue

                # Redact matched content (show first/last 2 chars only)
                redacted = []
                for m in matches[:3]:
                    ms = m if isinstance(m, str) else str(m)
                    if len(ms) > 6:
                        redacted.append(ms[:2] + "*" * (len(ms) - 4) + ms[-2:])
                    else:
                        redacted.append("*" * len(ms))

                action_key = SEVERITY_ACTION_KEY.get(severity, "mediumSeverity")
                action = LEVEL_CONFIG.get(action_key, "audit")

                findings.append({
                    "category": category,
                    "subcategory": subcat_name,
                    "description": subcat_data.get("description", ""),
                    "severity": severity,
                    "matchCount": len(matches),
                    "redactedSamples": redacted,
                    "action": action,
                })

    return findings


# ---------------------------------------------------------------------------
# Audit logging (append-only JSONL)
# ---------------------------------------------------------------------------
def write_audit_log(event: str, findings: list, action_taken: str,
                    tool_name: str = ""):
    entry = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event": event,
        "governanceLevel": GOVERNANCE_LEVEL,
        "toolName": tool_name,
        "actionTaken": action_taken,
        "findingCount": len(findings),
        "findings": findings,
    }
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass  # Never crash on audit write failure


# ---------------------------------------------------------------------------
# Session summary generation
# ---------------------------------------------------------------------------
def generate_session_summary() -> dict:
    if not AUDIT_LOG.exists():
        return {"message": "No audit events recorded."}

    total_events = 0
    total_findings = 0
    blocked = warned = audited = 0
    by_category: dict[str, int] = defaultdict(int)
    by_severity: dict[str, int] = defaultdict(int)
    threat_timeline = []

    try:
        with open(AUDIT_LOG) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                total_events += 1
                findings = entry.get("findings", [])
                total_findings += len(findings)

                for finding in findings:
                    by_category[finding.get("category", "unknown")] += 1
                    by_severity[finding.get("severity", "unknown")] += 1

                act = entry.get("actionTaken", "audit")
                if act == "deny":
                    blocked += 1
                elif act == "ask":
                    warned += 1
                else:
                    audited += 1

                if findings:
                    threat_timeline.append({
                        "timestamp": entry.get("timestamp"),
                        "event": entry.get("event"),
                        "toolName": entry.get("toolName", ""),
                        "categories": list({f.get("category") for f in findings}),
                    })
    except OSError:
        return {"message": "Could not read audit log."}

    summary = {
        "governanceLevel": GOVERNANCE_LEVEL,
        "totalEvents": total_events,
        "totalFindings": total_findings,
        "blocked": blocked,
        "warned": warned,
        "audited": audited,
        "findingsByCategory": dict(by_category),
        "findingsBySeverity": dict(by_severity),
        "threatTimeline": threat_timeline[-20:],
    }

    try:
        with open(SESSION_SUMMARY, "w") as f:
            json.dump(summary, f, indent=2)
    except OSError:
        pass

    return summary


# ---------------------------------------------------------------------------
# Build response JSON
# ---------------------------------------------------------------------------
def build_reason(findings: list) -> str:
    lines = []
    for f in findings:
        icon = "🔴" if f["severity"] == "high" else (
            "🟡" if f["severity"] == "medium" else "🟢")
        act = f.get("action", "audit").upper()
        lines.append(
            f'{icon} [{act}] {f["category"]}/{f["subcategory"]}: '
            f'{f["description"]} ({f["matchCount"]} match(es))'
        )
    return "\n".join(lines)


def output_and_exit(data: dict, exit_code: int = 0):
    """Print JSON to stdout and exit."""
    json.dump(data, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(exit_code)


def handle_session_start(hook_data: dict):
    write_audit_log("SessionStart", [], "audit")
    output_and_exit({
        "systemMessage": (
            f"🛡️ Governance Scanner Active\n\n"
            f"Level: {GOVERNANCE_LEVEL}\n"
            f"Threat detection: sensitive data, credentials, exfiltration, "
            f"privilege escalation, destruction, prompt injection.\n"
            f"All events logged to audit trail."
        )
    })


def handle_session_stop(hook_data: dict):
    summary = generate_session_summary()
    write_audit_log("Stop", [], "audit")
    output_and_exit({
        "systemMessage": (
            f"🛡️ Governance Session Summary\n\n"
            f"{json.dumps(summary, indent=2)}"
        )
    })


def handle_scan_event(hook_data: dict):
    scan_text = extract_scan_text(hook_data)

    if not scan_text or scan_text.strip() == "":
        write_audit_log(EVENT_TYPE, [], "allow",
                        hook_data.get("toolName", ""))
        output_and_exit({"continue": True})

    findings = scan_for_threats(scan_text)

    if not findings:
        write_audit_log(EVENT_TYPE, [], "allow",
                        hook_data.get("toolName", ""))
        output_and_exit({"continue": True})

    # Determine highest-priority action
    priority = {"deny": 3, "ask": 2, "audit": 1}
    max_action = max(
        (f.get("action", "audit") for f in findings),
        key=lambda a: priority.get(a, 0),
    )

    reason = build_reason(findings)
    tool_name = hook_data.get("toolName", "")
    write_audit_log(EVENT_TYPE, findings, max_action, tool_name)

    if max_action == "deny":
        if EVENT_TYPE == "PreToolUse":
            output_and_exit({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"🛡️ GOVERNANCE BLOCK ({GOVERNANCE_LEVEL})\n\n{reason}"
                    ),
                }
            }, exit_code=2)
        else:
            # UserPromptSubmit or PostToolUse — exit 2 = blocking error
            output_and_exit({
                "continue": False,
                "stopReason": (
                    f"🛡️ GOVERNANCE BLOCK ({GOVERNANCE_LEVEL})\n\n{reason}"
                ),
            }, exit_code=2)

    elif max_action == "ask":
        if EVENT_TYPE == "PreToolUse":
            output_and_exit({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": (
                        f"🛡️ GOVERNANCE WARNING ({GOVERNANCE_LEVEL})\n\n{reason}"
                    ),
                }
            })
        else:
            output_and_exit({
                "continue": False,
                "stopReason": (
                    f"🛡️ GOVERNANCE WARNING ({GOVERNANCE_LEVEL})\n\n{reason}"
                ),
            }, exit_code=2)

    else:  # audit
        output_and_exit({
            "systemMessage": (
                f"🛡️ GOVERNANCE AUDIT ({GOVERNANCE_LEVEL})\n\n{reason}"
            ),
        })


# ===========================================================================
# Main
# ===========================================================================
def main():
    hook_data = read_stdin()

    if EVENT_TYPE == "SessionStart":
        handle_session_start(hook_data)
    elif EVENT_TYPE == "Stop":
        handle_session_stop(hook_data)
    elif EVENT_TYPE in ("UserPromptSubmit", "PreToolUse", "PostToolUse"):
        handle_scan_event(hook_data)
    else:
        output_and_exit({"continue": True})


if __name__ == "__main__":
    main()
