#!/usr/bin/env python3
"""
Fetch Gatekeeper Council workflow results from GitHub Actions.

Usage:
    # Fetch by workflow run ID
    python scripts/fetch-council-results.py --run-id 21980488875

    # Fetch the latest council-query run
    python scripts/fetch-council-results.py --latest

    # Fetch and output raw JSON (for piping to other tools)
    python scripts/fetch-council-results.py --latest --json

    # Specify a different repo
    python scripts/fetch-council-results.py --latest --repo owner/repo

Prerequisites:
    - GitHub CLI (`gh`) installed and authenticated
    - Or set GITHUB_TOKEN environment variable

The script downloads the specified artifact from the workflow run,
extracts the JSON, and displays the council response.

Supported Workflows (--workflow presets):
    gatekeeper        — Gatekeeper Analysis (default)
    feature-analysis  — Feature Requirement Analysis (triggered by 'gate-keeper' label)
    council           — Council Query (ad-hoc queries)

Examples:
    # Fetch the latest Gatekeeper Analysis run (default)
    python scripts/fetch-council-results.py --latest

    # Fetch the latest Feature Requirement Analysis run
    python scripts/fetch-council-results.py --latest --workflow feature-analysis

    # Fetch a specific run
    python scripts/fetch-council-results.py --run-id 21981730099 -o results.json

    # Fetch a specific artifact from a run
    python scripts/fetch-council-results.py --run-id 123 --artifact-name council-results

    # Fetch latest Council Query run with its artifact
    python scripts/fetch-council-results.py --latest --workflow council

    # Override with explicit workflow-name and artifact-name
    python scripts/fetch-council-results.py --latest --workflow-name "Council Query" --artifact-name council-results
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def run_gh(args: list[str], check: bool = True) -> str:
    """Run a gh CLI command and return stdout."""
    cmd = ["gh"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def get_repo() -> str:
    """Detect the current repo from git remote."""
    try:
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, check=True
        ).stdout.strip()
        # Parse owner/repo from URLs like:
        #   https://github.com/owner/repo.git
        #   git@github.com:owner/repo.git
        if "github.com" in remote:
            parts = remote.rstrip(".git").split("github.com")[-1]
            parts = parts.lstrip("/").lstrip(":")
            return parts
    except Exception:
        pass
    return ""


def get_latest_run_id(repo: str, workflow_name: str = "Gatekeeper Analysis") -> str:
    """Get the latest workflow run ID for the given workflow name."""
    output = run_gh([
        "api", f"repos/{repo}/actions/workflows",
        "--jq", f'.workflows[] | select(.name == "{workflow_name}") | .id'
    ])
    if not output:
        print(f"Error: Could not find '{workflow_name}' workflow in this repo.", file=sys.stderr)
        sys.exit(1)

    workflow_id = output.strip().split("\n")[0]

    output = run_gh([
        "api", f"repos/{repo}/actions/workflows/{workflow_id}/runs?per_page=1&status=completed",
        "--jq", ".workflow_runs[0].id",
    ])
    if not output:
        print(f"Error: No completed '{workflow_name}' runs found.", file=sys.stderr)
        sys.exit(1)

    return output.strip()


def get_run_metadata(repo: str, run_id: str) -> dict:
    """Get workflow run metadata."""
    output = run_gh([
        "api", f"repos/{repo}/actions/runs/{run_id}",
        "--jq", '{id: .id, status: .status, conclusion: .conclusion, '
                'created_at: .created_at, updated_at: .updated_at, '
                'html_url: .html_url, head_sha: .head_sha, '
                'display_title: .display_title}'
    ])
    return json.loads(output)


def download_artifact(repo: str, run_id: str, artifact_name: str = "gatekeeper-final-analysis") -> dict:
    """Download and parse the specified artifact."""
    # List artifacts for this run
    output = run_gh([
        "api", f"repos/{repo}/actions/runs/{run_id}/artifacts",
        "--jq", f'.artifacts[] | select(.name == "{artifact_name}") | .id'
    ])
    if not output:
        print(f"Error: No '{artifact_name}' artifact found for this run.", file=sys.stderr)
        print("The workflow may still be running, or it failed before generating results.", file=sys.stderr)
        # List available artifacts to help the user
        avail = run_gh([
            "api", f"repos/{repo}/actions/runs/{run_id}/artifacts",
            "--jq", '.artifacts[].name'
        ], check=False)
        if avail:
            print(f"Available artifacts: {', '.join(avail.strip().split(chr(10)))}", file=sys.stderr)
        sys.exit(1)

    artifact_id = output.strip().split("\n")[0]

    # Download the artifact zip
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, "artifact.zip")
        cmd = [
            "gh", "api",
            f"repos/{repo}/actions/artifacts/{artifact_id}/zip",
        ]
        result = subprocess.run(cmd, capture_output=True, check=False)
        if result.returncode != 0:
            print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
            print(result.stderr.decode() if isinstance(result.stderr, bytes) else result.stderr, file=sys.stderr)
            sys.exit(1)
        with open(zip_path, "wb") as zf_out:
            zf_out.write(result.stdout)

        # Extract
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmpdir)

        # Find and parse JSON files in the artifact
        # Try common names: council-results.json, gatekeeper-consolidated.json, or any .json
        json_candidates = ["council-results.json", "gatekeeper-consolidated.json"]
        json_path = None

        # First try known filenames in the tmpdir root
        for candidate in json_candidates:
            path = os.path.join(tmpdir, candidate)
            if os.path.exists(path):
                json_path = path
                break

        # Then search recursively
        if not json_path:
            for candidate in json_candidates:
                for root, _, files in os.walk(tmpdir):
                    if candidate in files:
                        json_path = os.path.join(root, candidate)
                        break
                if json_path:
                    break

        # Fall back to any .json file
        if not json_path:
            for root, _, files in os.walk(tmpdir):
                for f in files:
                    if f.endswith(".json"):
                        json_path = os.path.join(root, f)
                        break
                if json_path:
                    break

        if not json_path:
            print("Error: No JSON file found in artifact.", file=sys.stderr)
            sys.exit(1)

        print(f"Parsing: {os.path.basename(json_path)}", file=sys.stderr)
        with open(json_path) as f:
            return json.load(f)


def print_divider(char: str = "─", width: int = 70):
    print(char * width)


def print_results(results: dict, run_meta: dict):
    """Pretty-print the council results."""
    print()
    print_divider("═")
    print("  🏛️  COUNCIL WORKFLOW RESULTS")
    print_divider("═")
    print()

    # Run metadata
    print(f"  Run ID:     {run_meta.get('id', 'N/A')}")
    print(f"  Status:     {run_meta.get('conclusion', 'N/A')}")
    print(f"  Started:    {run_meta.get('created_at', 'N/A')}")
    print(f"  Completed:  {run_meta.get('updated_at', 'N/A')}")
    print(f"  URL:        {run_meta.get('html_url', 'N/A')}")
    print()
    print_divider()
    print(f"  📋 Query: {results.get('query', 'N/A')}")
    print(f"  🤖 Council: {', '.join(results.get('models', {}).get('council', []))}")
    print(f"  👔 Chairman: {results.get('models', {}).get('chairman', 'N/A')}")
    print_divider()

    # Stage 3 — Final Answer (shown first, most important)
    print()
    print("  ╔══════════════════════════════════════════════════════════════════╗")
    print("  ║  📝 STAGE 3 — Chairman's Final Answer                          ║")
    print("  ╚══════════════════════════════════════════════════════════════════╝")
    print()
    stage3 = results.get("stage3", {})
    print(f"  Model: {stage3.get('chairman_model', 'N/A')}")
    print()
    final = stage3.get("final_answer", "No answer available.")
    for line in final.split("\n"):
        print(f"  {line}")
    print()

    # Aggregate rankings
    print_divider()
    print()
    print("  📊 AGGREGATE PEER RANKINGS")
    print()
    rankings = results.get("aggregate_rankings", [])
    if rankings:
        print(f"  {'Model':<25} {'Avg Rank':<12} {'Votes':<8}")
        print(f"  {'─' * 25} {'─' * 12} {'─' * 8}")
        for r in rankings:
            print(f"  {r['model']:<25} {r['avg_rank']:<12} {r['votes']:<8}")
    else:
        print("  No rankings available.")
    print()

    # Stage 1 — Individual Responses
    print_divider()
    print()
    print("  🔍 STAGE 1 — Individual Model Responses")
    print()
    stage1 = results.get("stage1", {})
    for model, response in stage1.items():
        print(f"  ┌── {model} ──")
        if response:
            # Show first 500 chars with option to see full
            preview = response[:500]
            for line in preview.split("\n"):
                print(f"  │ {line}")
            if len(response) > 500:
                print(f"  │ ... ({len(response) - 500} more chars, use --json for full output)")
        else:
            print("  │ (no response)")
        print(f"  └{'─' * 50}")
        print()

    # Stage 2 — Peer Rankings
    print_divider()
    print()
    print("  ⚖️  STAGE 2 — Peer Rankings")
    print()
    stage2 = results.get("stage2", {})
    for model, ranking in stage2.items():
        print(f"  ┌── {model}'s ranking ──")
        if ranking:
            preview = ranking[:400]
            for line in preview.split("\n"):
                print(f"  │ {line}")
            if len(ranking) > 400:
                print(f"  │ ... ({len(ranking) - 400} more chars)")
        else:
            print("  │ (no ranking)")
        print(f"  └{'─' * 50}")
        print()

    print_divider("═")
    print("  ✅ Council results retrieved successfully")
    print_divider("═")
    print()


# Preset mappings for known workflows
WORKFLOW_PRESETS = {
    "gatekeeper": {
        "workflow_name": "Gatekeeper Analysis",
        "artifact_name": "gatekeeper-final-analysis",
    },
    "feature-analysis": {
        "workflow_name": "Feature Requirement Analysis",
        "artifact_name": "feature-requirement-analysis",
    },
    "council": {
        "workflow_name": "Council Query",
        "artifact_name": "council-results",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Fetch Gatekeeper Council workflow results from GitHub Actions"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-id", help="Workflow run ID to fetch results for")
    group.add_argument("--latest", action="store_true", help="Fetch the latest completed run")
    parser.add_argument("--repo", help="Repository (owner/repo). Auto-detected from git if omitted")
    parser.add_argument("--json", action="store_true", dest="raw_json",
                        help="Output raw JSON instead of formatted text")
    parser.add_argument("--output", "-o", help="Save results JSON to this file path")
    parser.add_argument("--workflow", choices=list(WORKFLOW_PRESETS.keys()),
                        help="Workflow preset: gatekeeper (default), feature-analysis, or council")
    parser.add_argument("--artifact-name",
                        help="Name of the artifact to download (overrides --workflow preset)")
    parser.add_argument("--workflow-name",
                        help="Workflow name for --latest lookup (overrides --workflow preset)")

    args = parser.parse_args()

    # Apply workflow preset, then allow explicit overrides
    preset = WORKFLOW_PRESETS.get(args.workflow or "gatekeeper", WORKFLOW_PRESETS["gatekeeper"])
    if not args.workflow_name:
        args.workflow_name = preset["workflow_name"]
    if not args.artifact_name:
        args.artifact_name = preset["artifact_name"]

    # Determine repo
    repo = args.repo or get_repo()
    if not repo:
        print("Error: Could not detect repository. Use --repo owner/repo", file=sys.stderr)
        sys.exit(1)

    print(f"Repository: {repo}", file=sys.stderr)

    # Determine run ID
    if args.latest:
        print(f"Finding latest '{args.workflow_name}' run...", file=sys.stderr)
        run_id = get_latest_run_id(repo, args.workflow_name)
    else:
        run_id = args.run_id

    print(f"Run ID: {run_id}", file=sys.stderr)

    # Get run metadata
    run_meta = get_run_metadata(repo, run_id)

    # Download and parse artifact
    print(f"Downloading '{args.artifact_name}' artifact...", file=sys.stderr)
    results = download_artifact(repo, run_id, args.artifact_name)

    # Save to file if requested
    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to {args.output}", file=sys.stderr)

    # Output
    if args.raw_json:
        output = {
            "run": run_meta,
            "results": results,
        }
        print(json.dumps(output, indent=2))
    else:
        print_results(results, run_meta)


if __name__ == "__main__":
    main()
