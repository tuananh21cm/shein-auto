import type { RouteDef } from "./types";
import { extractHomepage } from "./extractors/homepage";
import { extractCompassOverview } from "./extractors/compassOverview";

/**
 * Registry route v1. Mở rộng phase sau = thêm 1 entry + 1 extractor.
 * URL Compass có thể cần tinh chỉnh path sau discovery.
 */
export const ROUTES: RouteDef[] = [
  {
    key: "homepage",
    url: "https://seller-us.tiktok.com/homepage",
    settleMs: 4000,
    extractor: extractHomepage,
  },
  {
    key: "compass-overview",
    url: "https://seller-us.tiktok.com/compass/overview",
    settleMs: 5000,
    extractor: extractCompassOverview,
  },
];
