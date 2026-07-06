/**
 * Chạy tay crawl TikTok seller.
 *   npm run crawl:tiktok                       → cào + phân tích MỌI shop đã gán profile
 *   npm run crawl:tiktok -- --only-shop="TA Scan 152-Fashion Lace_US"  → 1 shop
 *   npm run crawl:tiktok -- --discover         → chỉ cào + dump raw endpoint (map)
 *   npm run crawl:tiktok -- --no-ai            → cào + lưu, bỏ AI
 */
import "dotenv/config";
import { runTiktokJob } from "../core/tiktokCron";

async function main() {
  const args = process.argv.slice(2);
  const discover = args.includes("--discover");
  const noAi = args.includes("--no-ai");
  const onlyShop = args.find((a) => a.startsWith("--only-shop="))?.slice("--only-shop=".length);
  await runTiktokJob({ discover, noAi, onlyShop, onLog: (m) => console.log("[tiktok]", m) });
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e);
  process.exit(1);
});
