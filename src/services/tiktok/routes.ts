import type { RouteDef } from "./types";
import { extractHomepage } from "./extractors/homepage";
import { extractShopOverview } from "./extractors/shopOverview";
import { extractPromotion } from "./extractors/promotion";
import { extractCampaign } from "./extractors/campaign";
import { extractMessages } from "./extractors/messages";

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
  {
    key: "promotion",
    url: "https://seller-us.tiktok.com/promotion/marketing-tools/tool-choose?shop_region=US",
    settleMs: 20000, // max chờ — thoát ngay khi endpoint fire
    skipCaptcha: true,
    waitForEndpoint: "promotion/period/stats",
    extractor: extractPromotion,
  },
  {
    key: "campaign",
    url: "https://seller-us.tiktok.com/promotion/campaign-tools/all",
    settleMs: 20000, // max chờ — thoát ngay khi endpoint fire
    skipCaptcha: true,
    waitForEndpoint: "parents_campaigns/list",
    extractor: extractCampaign,
  },
  {
    // Inbox: radar không miss thông báo chính sách (Violations/Policies/Account updates).
    // Dwell cố định (không waitForEndpoint) để mọi call pull_by_category_v2 + message/list
    // kịp fire — full-category list thường fire sau call partial đầu tiên.
    key: "messages",
    url: "https://seller-us.tiktok.com/message/center?shop_region=US&tab_id=-3000000",
    settleMs: 12000,
    skipCaptcha: true,
    extractor: extractMessages,
  },
];
