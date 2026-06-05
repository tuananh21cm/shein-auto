/**
 * Discovery phase 2: cào 1 loạt route seller center để DUMP endpoint (không bóc
 * chỉ số), phục vụ map extractor. KHÔNG đụng ROUTES production / cron.
 *
 *   npm run discover:tiktok
 *
 * Dump ra data/_tiktok_discovery/<ngày>/<route-key>/.
 */
import "dotenv/config";
import path from "path";
import { tiktokConfig } from "../config/appConfig";
import { crawlTiktokSeller } from "../core/crawlTiktokSeller";
import { TiktokDb } from "../services/tiktok/db";
import type { RouteDef } from "../services/tiktok/types";

// Batch người dùng chọn: Sales analytics + Health chi tiết + Reviews & returns.
const DISCOVER_ROUTES: { key: string; url: string }[] = [
  // Sales analytics
  { key: "data-overview", url: "https://seller-us.tiktok.com/compass/data-overview" },
  { key: "product-analysis", url: "https://seller-us.tiktok.com/compass/product-analysis" },
  { key: "customer-analysis", url: "https://seller-us.tiktok.com/compass/customer-analysis" },
  // Health chi tiết
  { key: "health-center", url: "https://seller-us.tiktok.com/health-center" },
  { key: "experience-score", url: "https://seller-us.tiktok.com/health-center/experience-score" },
  { key: "fulfillment-performance", url: "https://seller-us.tiktok.com/health-center/fulfillment-performance" },
  { key: "voc", url: "https://seller-us.tiktok.com/health-center/voc" },
  // Reviews & returns
  { key: "reviews", url: "https://seller-us.tiktok.com/compass/reviews" },
  { key: "cancel-returns", url: "https://seller-us.tiktok.com/compass/cancel-returns" },
  { key: "return-refund", url: "https://seller-us.tiktok.com/compass/return-refund" },
];

async function main() {
  const cfg = tiktokConfig();
  if (!cfg.profileId) throw new Error("Chưa cấu hình profileId trong config/tiktok.json");

  const routes: RouteDef[] = DISCOVER_ROUTES.map((r) => ({
    key: r.key,
    url: r.url,
    settleMs: 5000,
    extractor: () => [], // discovery: chỉ dump, không bóc
  }));

  const discoverDir = path.resolve(
    process.cwd(),
    "data",
    "_tiktok_discovery",
    new Date().toISOString().slice(0, 10) + "-phase2"
  );

  const db = new TiktokDb();
  const log = (m: string) => console.log("[discover]", m);
  try {
    log(`▶ Discovery ${routes.length} route → ${discoverDir}`);
    const snap = await crawlTiktokSeller({ profileId: cfg.profileId, db, routes, discoverDir, onLog: log });
    log(`Xong: status=${snap.status}`);
    for (const r of snap.routes) log(`  ${r.ok ? "✓" : "✗"} ${r.route}${r.error ? " — " + r.error : ""}`);
    log(`Dump tại: ${discoverDir}`);
  } finally {
    db.close();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e);
  process.exit(1);
});
