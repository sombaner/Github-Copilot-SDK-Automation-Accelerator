import { describe, expect, it } from "vitest";
import { searchCatalog } from "../../src/catalog/search";

describe("searchCatalog", () => {
    it("returns results for a matching keyword", () => {
        const results = searchCatalog("camera");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.id).toBe("sku-camera-01");
    });
});