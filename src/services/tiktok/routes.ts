import type { RouteDef, Capture } from "./types";
import { extractHomepage } from "./extractors/homepage";
import { extractShopOverview } from "./extractors/shopOverview";
import { extractPromotion } from "./extractors/promotion";
import { extractCampaign } from "./extractors/campaign";
import { extractMessages } from "./extractors/messages";
import { extractChat } from "./extractors/chat";
import { extractOrders } from "./extractors/orders";
import { extractReturns } from "./extractors/returns";
import { extractProductOpportunity } from "./extractors/productOpportunity";
import { extractProductManage, extractListingRows } from "./extractors/productManage";

/**
 * Registry route cào hằng ngày. Mở rộng = thêm 1 entry + 1 extractor.
 *
 * - `homepage`: route sạch (không captcha) → sức khỏe shop (AHR, vi phạm, settle, đơn).
 * - `shop-overview`: trang /compass/product-analysis fire endpoint v3 overview stats
 *   (revenue/traffic/conversion theo ngày). Route /compass/* dính captcha MỖI lần nhưng
 *   data fire trước overlay → dùng `skipCaptcha` (capture-first): load, hứng, đóng nhanh,
 *   KHÔNG chờ giải captcha. Extractor compassOverview (legacy) giữ cho phase sau.
 */
/**
 * Click sang TRANG 2 của Quản lý sản phẩm khi shop >50 SP (mỗi trang 50, shop hiện ~100 SP)
 * → app tự fire products/list?page_number=2, captureBus hứng thêm capture, extractor gộp 2 trang.
 * Best-effort: không thấy nút / capture không về → giữ trang 1, log cảnh báo.
 */
export async function paginateProductManage(
  page: any,
  bus: { snapshot(): Capture[] },
  log: (m: string) => void
): Promise<void> {
  const listCaps = () => bus.snapshot().filter((c) => /product\/local\/products\/list/.test(c.url));
  const first = listCaps()[0];
  const total = Number(first?.body?.data?.total_product_count ?? first?.body?.total_product_count ?? 0);
  if (!total || total <= 50) return; // 1 trang là đủ
  const before = listCaps().length;

  // pagination nằm dưới đáy danh sách → cuộn xuống cho nút render
  await page.mouse.wheel(0, 5000).catch(() => {});
  await page.waitForTimeout(800);

  // DOM thật (xác minh 2026-07-06): <div data-tid="m4b_pagination" class="core-pagination">
  //   <li class="core-pagination-item" aria-label="Page 2">2</li> · next = li.core-pagination-item-next
  const candidates = [
    page.locator('li.core-pagination-item[aria-label="Page 2"]').first(),
    page.locator('[data-tid="m4b_pagination"] li[aria-label="Page 2"]').first(),
    // fallback khi TikTok đổi class/tid: li số "2" trong khối pagination bất kỳ, rồi nút Next
    page.locator('[class*="pagination"] li:not([class*="prev"]):not([class*="next"])', { hasText: /^2$/ }).first(),
    page.locator('li[class*="pagination-item-next"]:not([class*="disabled"])').first(),
  ];
  let clicked = false;
  for (const loc of candidates) {
    if (!(await loc.count().catch(() => 0))) continue;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    clicked = await loc.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) break;
  }
  if (!clicked) {
    log(`  ⚠️ ${total} SP (>50) nhưng không thấy nút trang 2 — snapshot chỉ có trang đầu.`);
    return;
  }
  log(`  → ${total} SP: đã click trang 2, chờ capture…`);
  const start = Date.now();
  while (Date.now() - start < 15_000 && listCaps().length <= before) {
    await page.waitForTimeout(1000);
  }
  log(
    listCaps().length > before
      ? `  ✓ trang 2 đã về (${listCaps().length} capture products/list).`
      : `  ⚠️ click trang 2 nhưng không thấy capture mới sau 15s — dùng trang đầu.`
  );
}

export const ROUTES: RouteDef[] = [
  {
    key: "homepage",
    url: "https://seller-us.tiktok.com/homepage",
    settleMs: 4000,
    extractor: extractHomepage,
  },
  {
    // Quản lý order: Action Needed (ship 24h/quá hạn/hủy/hoàn) + đếm trạng thái
    key: "orders",
    url: "https://seller-us.tiktok.com/order?shop_region=US",
    settleMs: 15000,
    skipCaptcha: true,
    waitForEndpoint: "fulfillment/na/dashboard/get",
    extractor: extractOrders,
  },
  {
    // Quản lý return & refund: respond 24h, auto-approved, can-appeal, disputes
    key: "returns",
    url: "https://seller-us.tiktok.com/order/return?from=menu&shop_region=US",
    settleMs: 15000,
    skipCaptcha: true,
    waitForEndpoint: "reverse/dashboard/get",
    extractor: extractReturns,
  },
  {
    // Product opportunities: top keyword/sp theo cầu/cung (gợi ý nên list hàng gì)
    key: "product-opportunity",
    url: "https://seller-us.tiktok.com/product/opportunity?shop_region=US&sort_field=1&use_like=false",
    settleMs: 20000,
    skipCaptcha: true,
    waitForEndpoint: "seller_product_opportunity/seller/lead/list",
    extractor: extractProductOpportunity,
  },
  {
    // Quản lý sản phẩm: tổng SP, views 28d, tồn kho thấp/hết, top SP theo views
    key: "product-manage",
    url: "https://seller-us.tiktok.com/product/manage?shop_region=US",
    settleMs: 20000,
    skipCaptcha: true,
    waitForEndpoint: "product/local/products/list",
    extractor: extractProductManage,
    // Snapshot per-listing (pv/order 28d) → listing_views (diff hôm qua / 7 ngày)
    listingExtractor: extractListingRows,
    // Shop >50 SP → click trang 2 hứng đủ (~100 SP, 50/trang)
    interact: paginateProductManage,
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
    // radar chính sách + thống kê customer messages (chat unread/queue) trên cùng trang
    extractor: (caps) => [...extractMessages(caps), ...extractChat(caps)],
  },
  {
    // Tab Account activity — lấy tin hiện ra (passive)
    key: "messages-account",
    url: "https://seller-us.tiktok.com/message/center?shop_region=US&tab_id=-4000000",
    settleMs: 12000,
    skipCaptcha: true,
    extractor: extractMessages,
  },
  {
    // Tab Marketing & promotions — lấy tin hiện ra (passive)
    key: "messages-marketing",
    url: "https://seller-us.tiktok.com/message/center?shop_region=US&tab_id=-5000000",
    settleMs: 12000,
    skipCaptcha: true,
    extractor: extractMessages,
  },
];
