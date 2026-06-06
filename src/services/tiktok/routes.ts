import type { RouteDef } from "./types";
import { extractHomepage } from "./extractors/homepage";
import { extractShopOverview } from "./extractors/shopOverview";

/**
 * Registry route cào hằng ngày. Mở rộng = thêm 1 entry + 1 extractor.
 *
 * - `homepage`: route sạch (không captcha) → sức khỏe shop (AHR, vi phạm, settle, đơn).
 * - `shop-overview`: trang /compass/product-analysis fire endpoint v3 overview stats
 *   (revenue/traffic/conversion theo ngày). Route /compass/* dính captcha MỖI lần nhưng
 *   data fire trước overlay → dùng `skipCaptcha` (capture-first): load, hứng, đóng nhanh,
 *   KHÔNG chờ giải captcha. Extractor compassOverview (legacy) giữ cho phase sau.
 */
export const ROUTES: RouteDef[] = [
  {
    key: "homepage",
    url: "https://seller-us.tiktok.com/homepage",
    settleMs: 4000,
    extractor: extractHomepage,
  },
  {
    key: "shop-overview",
    url: "https://seller-us.tiktok.com/compass/product-analysis",
    settleMs: 25000, // max chờ — thoát ngay khi endpoint fire
    skipCaptcha: true,
    waitForEndpoint: "v3/insights/seller/shop/overview/performance/stats",
    extractor: extractShopOverview,
  },
];
