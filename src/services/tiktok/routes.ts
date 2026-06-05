import type { RouteDef } from "./types";
import { extractHomepage } from "./extractors/homepage";

/**
 * Registry route cào hằng ngày. Mở rộng phase sau = thêm 1 entry + 1 extractor.
 *
 * v1: CHỈ homepage — route này luôn sạch (không captcha) và cho đủ bộ chỉ số
 * sức khỏe shop (AHR, vi phạm, settlement, đơn). Route `compass-overview` đã bị
 * tạm gỡ khỏi crawl hằng ngày vì (1) trigger captcha mỗi lần → kẹt cron không
 * người canh, (2) endpoint sales/traffic (GMV) chưa bắt được. Extractor compass
 * (extractors/compassOverview.ts) vẫn giữ để dùng lại ở phase 2 khi giải quyết
 * captcha + map được endpoint analytics.
 */
export const ROUTES: RouteDef[] = [
  {
    key: "homepage",
    url: "https://seller-us.tiktok.com/homepage",
    settleMs: 4000,
    extractor: extractHomepage,
  },
];
