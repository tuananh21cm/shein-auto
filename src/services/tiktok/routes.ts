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
    // GAP (discovery 2026-06-05): endpoint sales/traffic của Compass (GMV/visitors/
    // conversion) chưa fire trong lượt cào — chart load lazy sau captcha. Cần dwell lâu
    // hơn / scroll tới chart hoặc xác định endpoint analytics ở lần discovery sau.
    key: "compass-overview",
    url: "https://seller-us.tiktok.com/compass/overview",
    settleMs: 8000,
    extractor: extractCompassOverview,
  },
];
