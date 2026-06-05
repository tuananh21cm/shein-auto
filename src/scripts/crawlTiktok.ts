/**
 * Chạy tay crawl TikTok seller.
 *   npm run crawl:tiktok                 → cào + phân tích + report
 *   npm run crawl:tiktok -- --discover   → chỉ cào + dump raw endpoint (map)
 *   npm run crawl:tiktok -- --no-ai      → cào + lưu, bỏ AI
 */
import "dotenv/config";
import { runTiktokJob } from "../core/tiktokCron";

async function main() {
  const args = process.argv.slice(2);
  const discover = args.includes("--discover");
  const noAi = args.includes("--no-ai");
  await runTiktokJob({ discover, noAi, onLog: (m) => console.log("[tiktok]", m) });
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e);
  process.exit(1);
});
