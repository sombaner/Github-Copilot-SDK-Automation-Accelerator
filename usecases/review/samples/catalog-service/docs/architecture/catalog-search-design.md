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