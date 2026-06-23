/**
 * Chạy TAY 1 cycle auto-crawl (cào batchSize sp uncrawled qua Chrome CDP).
 *   npm run crawl:auto
 * Cần Chrome mở --remote-debugging-port=9222. Config: crawl.json.
 */
import "dotenv/config";
import { initDb, closeDb } from "../state/db";
import { runCrawlCycle } from "../core/autoCrawler";
import { crawlConfig } from "../config/appConfig";

async function main() {
  await initDb();
  const cfg = crawlConfig();
  console.log(`▶ Auto-crawl cycle (batch ${cfg.batchSize}, CDP ${cfg.cdpUrl})…`);
  const r = await runCrawlCycle({
    batchSize: cfg.batchSize,
    cdpUrl: cfg.cdpUrl,
    maxAttempts: cfg.maxAttempts,
    onLog: (m) => console.log(m),
  });
  console.log(`\n✅ ok ${r.ok} · recrawl ${r.requeued} · bỏ ${r.gaveup} · còn ~${r.remaining} sp uncrawled`);
  closeDb();
}
main().then(() => process.exit(0)).catch((e) => { console.error("LỖI:", e.message); process.exit(1); });
