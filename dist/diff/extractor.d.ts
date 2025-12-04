import { DiffMetadata, DiffFile } from '../api/client';
export declare function extractDiffMetadata(): Promise<DiffMetadata>;
/**
 * Extract likely URL paths from changed file paths.
 * Maps common file naming conventions to URL routes.
 *
 * Examples:
 * - src/pages/Dashboard/MultiStore.tsx -> /dashboard/multi-store
 * - app/dashboard/settings/page.tsx -> /dashboard/settings
 * - components/StorePerformance.tsx -> (no URL, component only)
 */
export declare function extractLikelyUrls(files: DiffFile[]): string[];
//# sourceMappingURL=extractor.d.ts.map