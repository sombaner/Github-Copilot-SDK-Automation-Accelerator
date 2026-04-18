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