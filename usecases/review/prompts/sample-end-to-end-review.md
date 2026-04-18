<!-- review-config
{
  "review_types": ["architecture", "design", "code"],
  "pull_request": {
    "number": 9001,
    "title": "Add lightweight catalog search flow",
    "url": "https://github.com/microsoft/Github-Copilot-SDK-Automation-Accelerator/pull/9001",
    "base_ref": "main",
    "head_ref": "sample/catalog-search"
  },
  "github_spaces": [
    {
      "name": "review-agent-contract",
      "owner": "sombaner",
      "repo": "tailspin-toystore",
      "ref": "main",
      "review_types": ["architecture", "design"],
      "instructions": ["docs/architecture.md"],
      "context": ["docs/architecture.md", "CONTRIBUTING.md"],
      "description": "Use the existing review-use-case contract and repo architecture notes as sample external guidance."
    },
    {
      "name": "repo-quality-baseline",
      "owner": "sombaner",
      "repo": "tailspin-toystore",
      "ref": "main",
      "review_types": ["code"],
      "instructions": ["docs/code-review-context.md"],
      "context": ["docs/code-review-context.md", "docs/test-review-context.md"],
      "description": "Use the repository's coding and testing and contribution guidance as sample code-review context."
    }
  ],
  "changed_files": [
    {
      "path": "usecases/review/samples/catalog-service/docs/architecture/catalog-search-design.md",
      "kind": "architecture"
    },
    {
      "path": "usecases/review/samples/catalog-service/src/catalog/search.ts",
      "kind": "code"
    },
    {
      "path": "usecases/review/samples/catalog-service/tests/catalog/search.test.ts",
      "kind": "unit-test"
    }
  ],
  "instructions": [
    "Use the attached prompt file as the primary source of truth for the proposed change.",
    "Use the declared GitHub Spaces for external review guidance.",
    "Review both the design intent and the implementation details.",
    "Treat the inline file snapshots below as the effective diff under review."
  ]
}
-->

# Review Request

Review a small sample pull request that introduces a lightweight catalog search flow.

## Source Repository Context

- Source repository: `sombaner/tailspin-toystore`
- Simulated branch: `sample/catalog-search`
- Review intent: evaluate design quality, implementation correctness, and test coverage

## What To Review

- The design says search should cover product name, description, and tags.
- The design says short or empty queries should be rejected.
- The design says only the top 10 ranked results should be returned.
- The code and tests should align with that design.

## Changed File Snapshot: `usecases/review/samples/catalog-service/docs/architecture/catalog-search-design.md`

```md
# Catalog Search Design

## Overview

This change adds a lightweight search capability to the catalog service so storefront callers can search products by keyword.

## Goals

- Return relevant catalog items for a free-text query.
- Keep the implementation simple enough to ship in one pull request.
- Reuse the same logic for the API layer and future background indexing work.

## Scope

- Add a search module in the service layer.
- Search across product name, description, and tags.
- Reject empty queries and queries shorter than 2 characters.
- Return only the top 10 ranked results.

## Proposed Approach

- Load the current catalog into memory.
- Perform substring matching over product fields.
- Rank exact name matches first, then partial matches, then tag matches.
- Keep the first implementation synchronous.

## Non-Functional Notes

- This endpoint is expected to stay below 150 ms at p95.
- The search result ordering should be deterministic.
- The service should avoid loading large catalog files on every request.

## Risks

- Search quality may be basic until relevance scoring is improved.
- The current release does not include typo tolerance.
```

## Changed File Snapshot: `usecases/review/samples/catalog-service/src/catalog/search.ts`

```ts
export interface CatalogItem {
    id: string;
    name: string;
    description: string;
    tags: string[];
}

export const SAMPLE_CATALOG: CatalogItem[] = [
    {
        id: "sku-camera-01",
        name: "Camera Pro",
        description: "Mirrorless travel camera",
        tags: ["photo", "travel", "mirrorless"],
    },
    {
        id: "sku-tripod-01",
        name: "Tripod Lite",
        description: "Compact tripod for mobile creators",
        tags: ["photo", "video"],
    },
    {
        id: "sku-bag-01",
        name: "Travel Bag",
        description: "Weather resistant bag for camera gear",
        tags: ["bags", "travel"],
    },
];

const DEFAULT_LIMIT = 20;

export function searchCatalog(
    query: string,
    items: CatalogItem[] = SAMPLE_CATALOG,
    limit = DEFAULT_LIMIT,
): CatalogItem[] {
    const normalizedQuery = query.toLowerCase();

    return items
        .filter((item) => item.name.includes(normalizedQuery) || item.description.includes(normalizedQuery))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit);
}
```

## Changed File Snapshot: `usecases/review/samples/catalog-service/tests/catalog/search.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { searchCatalog } from "../../src/catalog/search";

describe("searchCatalog", () => {
    it("returns results for a matching keyword", () => {
        const results = searchCatalog("camera");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.id).toBe("sku-camera-01");
    });
});
```

## Expected Review Shape

- Produce separate architecture/design and code review sections if both streams are triggered.
- Call out mismatches between the design and the implementation.
- Call out missing tests and residual risk.