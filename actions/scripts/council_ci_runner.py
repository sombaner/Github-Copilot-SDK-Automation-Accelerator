#!/usr/bin/env python3
"""
CI runner for the Gatekeeper Council using GitHub Copilot SDK.

Replaces the shell-based Copilot CLI approach in the workflow with
a clean Python script that leverages copilot_client.py and council.py.

Usage:
    QUERY_TEXT="your question" python scripts/council_ci_runner.py

Environment Variables:
    QUERY_TEXT       - The user's question about the codebase (required)
    OUTPUT_DIR       - Where to write results (default: /tmp/council-results)
"""

import asyncio
import json
import os
import sys

from council import run_council
from copilot_client import shutdown_client
from config import COUNCIL_MODELS, CHAIRMAN_MODEL


def write_step_summary(query: str, result: dict, output_dir: str):
    """Write GitHub Actions step summary as Markdown."""
    stage1 = result["stage1"]
    stage2 = result["stage2"]
    stage3 = result["stage3"]
    rankings = result["metadata"].get("aggregate_rankings", [])

    md = []
    md.append("# 🏛️ Gatekeeper Council Response")
    md.append("")
    md.append(f"> **Query:** {query}")
    md.append("")
    md.append("---")
    md.append("")
    md.append(f"## 📝 Stage 3 — Chairman's Final Answer ({stage3['model']})")
    md.append("")
    md.append(stage3.get("response", "_Chairman synthesis unavailable._"))
    md.append("")
    md.append("---")
    md.append("")
    md.append("## 📊 Aggregate Peer Rankings")
    md.append("")

    if rankings:
        md.append("| Model | Avg Rank | Votes |")
        md.append("|-------|----------|-------|")
        for r in rankings:
            md.append(f"| {r['model']} | {r['average_rank']} | {r['rankings_count']} |")
    else:
        md.append("_Rankings unavailable._")

    md.append("")
    md.append("---")
    md.append("")
    md.append("<details>")
    md.append("<summary>🔍 Stage 1 — Individual Model Responses</summary>")
    md.append("")
    for r in stage1:
        md.append(f"### {r['model']}")
        md.append("")
        md.append(r.get("response", "_No response._"))
        md.append("")
    md.append("</details>")
    md.append("")

    md.append("<details>")
    md.append("<summary>⚖️ Stage 2 — Peer Rankings</summary>")
    md.append("")
    for r in stage2:
        md.append(f"### {r['model']} ranking")
        md.append("")
        md.append(r.get("ranking", "_No ranking._"))
        md.append("")
    md.append("</details>")

    summary_path = os.path.join(output_dir, "step_summary.md")
    with open(summary_path, "w") as f:
        f.write("\n".join(md))

    # Also write to GITHUB_STEP_SUMMARY if available  
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a") as f:
            f.write("\n".join(md))
        print("Step summary written to GITHUB_STEP_SUMMARY")


async def main():
    query = os.environ.get("QUERY_TEXT", "").strip()
    if not query:
        print("ERROR: QUERY_TEXT environment variable is required")
        sys.exit(1)

    output_dir = os.environ.get("OUTPUT_DIR", "/tmp/council-results")
    os.makedirs(output_dir, exist_ok=True)

    print(f"Running council with query ({len(query)} chars)")
    print(f"Council models: {COUNCIL_MODELS}")
    print(f"Chairman model: {CHAIRMAN_MODEL}")

    # Run the 3-stage council (SDK navigates the codebase automatically)
    result = await run_council(query)

    # Shutdown SDK client
    await shutdown_client()

    # Build JSON output
    output = {
        "query": query,
        "models": {
            "council": [r["model"] for r in result["stage1"]],
            "chairman": result["stage3"]["model"],
        },
        "stage1": {r["model"]: r["response"] for r in result["stage1"]},
        "stage2": {r["model"]: r["ranking"] for r in result["stage2"]},
        "stage3": {
            "chairman_model": result["stage3"]["model"],
            "final_answer": result["stage3"]["response"],
        },
        "aggregate_rankings": result["metadata"].get("aggregate_rankings", []),
    }

    # Write JSON results
    results_path = os.path.join(output_dir, "council-results.json")
    with open(results_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Council results JSON created ({os.path.getsize(results_path)} bytes)")

    # Write chairman response for workflow output capture
    chairman_path = os.path.join(output_dir, "chairman_response.txt")
    with open(chairman_path, "w") as f:
        f.write(result["stage3"]["response"])

    # Write step summary
    write_step_summary(query, result, output_dir)

    print(f"✅ Council query complete — results written to {output_dir}")


if __name__ == "__main__":
    asyncio.run(main())
