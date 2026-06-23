/**
 * autoCrawler — cào uncrawled (shop_allocation status allocated/recrawl) NỀN LIÊN TỤC,
 * thay cho việc bấm "Cào Chrome → Listing" thủ công.
 *
 * Mỗi cycle: lấy batchSize sp (recrawl ưu tiên, rồi opportunity desc) toàn shop → cào qua
 * Chrome CDP → thiếu size_chart/lỗi → recrawl (cào lại sau). Quá maxAttempts → status='failed'
 * (ngừng lặp). Hết hàng → idle, vẫn poll (research bơm thêm).
 *
 * Yêu cầu: Chrome mở --remote-debugging-port=9222 (cdpUrl).
 */
import { getDb } from "../state/db";
import { getShopOwner, getUserDirsByName } from "../state/userDirs";
import { crawlConfig } from "../config/appConfig";

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  try { getDb().exec("ALTER TABLE shop_allocation ADD COLUMN crawl_attempts INTEGER DEFAULT 0"); } catch { /* đã có cột */ }
  schemaReady = true;
}

export interface CrawlCycleResult {
  ok: number;
  requeued: number;
  failed: number;
  gaveup: number;
  remaining: number;
}

export interface CrawlCycleOptions {
  batchSize: number;
  cdpUrl: string;
  maxAttempts: number;
  onLog?: (m: string) => void;
}

/** Chạy 1 cycle cào batchSize sp toàn shop. */
export async function runCrawlCycle(opts: CrawlCycleOptions): Promise<CrawlCycleResult> {
  ensureSchema();
  const log = opts.onLog ?? (() => {});
  const db = getDb();

  const items = db.prepare(
    `SELECT goods_id, name, url, shop, status, crawl_attempts FROM shop_allocation
     WHERE status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
     ORDER BY (status='recrawl') DESC, opportunity_score DESC LIMIT ?`
  ).all(opts.batchSize) as any[];
  const remaining = (db.prepare(
    "SELECT COUNT(*) n FROM shop_allocation WHERE status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''"
  ).get() as any).n;

  if (!items.length) return { ok: 0, requeued: 0, failed: 0, gaveup: 0, remaining: 0 };

  // owner→baseDir theo shop (cache)
  const baseDirByShop: Record<string, string | null> = {};
  for (const it of items) {
    if (it.shop in baseDirByShop) continue;
    const owner = await getShopOwner(it.shop);
    const dirs = owner ? await getUserDirsByName(owner) : null;
    baseDirByShop[it.shop] = dirs?.baseSheinAutoDir ?? null;
  }
  const meta: Record<string, { shop: string; status: string; attempts: number }> = {};
  for (const it of items) meta[it.goods_id] = { shop: it.shop, status: it.status, attempts: it.crawl_attempts ?? 0 };

  const markCrawled = db.prepare("UPDATE shop_allocation SET status='crawled' WHERE goods_id=?");
  const markRecrawl = db.prepare("UPDATE shop_allocation SET status='recrawl', crawl_attempts=? WHERE goods_id=?");
  const markFailed = db.prepare("UPDATE shop_allocation SET status='failed', crawl_attempts=? WHERE goods_id=?");

  const { scrapeBatchViaChrome } = await import("./scrapeViaChrome");
  const { dispatchScrapedData } = await import("./scrapeViaKiki");

  let ok = 0, requeued = 0, failed = 0, gaveup = 0;
  const requeue = (goodsId: string, why: string) => {
    const m = meta[goodsId];
    const attempts = m.attempts + 1;
    if (attempts >= opts.maxAttempts) { markFailed.run(attempts, goodsId); gaveup++; log(`🛑 ${goodsId} bỏ (thử ${attempts} lần): ${why}`); }
    else { markRecrawl.run(attempts, goodsId); requeued++; log(`⚠️ ${goodsId} → recrawl (${attempts}/${opts.maxAttempts}): ${why}`); }
  };

  await scrapeBatchViaChrome({
    items: items.map((it) => ({ goodsId: String(it.goods_id), url: it.url })),
    cdpUrl: opts.cdpUrl,
    onLog: log,
    onProduct: async (goodsId: string, data: any, error?: string) => {
      const shop = meta[goodsId].shop;
      const baseDir = baseDirByShop[shop];
      if (data && baseDir) {
        const sc = data.size_chart;
        const hasSize = !!(sc && ((sc.sections && sc.sections.length) || (sc.data && sc.data.length)));
        if (!hasSize) { requeue(goodsId, "thiếu size_chart"); return; }
        await dispatchScrapedData(baseDir, data, [shop]);
        markCrawled.run(goodsId); ok++;
        log(`✅ ${goodsId} OK · ${data.listing_variations?.colors?.length || 0} màu → listing queue`);
      } else if (data && !baseDir) {
        requeue(goodsId, `shop ${shop} thiếu baseSheinAutoDir`);
      } else {
        failed++; requeue(goodsId, error || "scrape fail");
      }
    },
  });

  return { ok, requeued, failed, gaveup, remaining };
}

/* ============= Background scheduler (self-rescheduling, liên tục) ============= */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function scheduleAutoCrawler(): void {
  const cfg = crawlConfig();
  if (!cfg.enabled) { console.log("⏰ Auto-crawl: TẮT (crawl.json → enabled=false)"); return; }

  const tick = async () => {
    if (running) return;
    running = true;
    let hadItems = false;
    try {
      const r = await runCrawlCycle({
        batchSize: cfg.batchSize,
        cdpUrl: cfg.cdpUrl,
        maxAttempts: cfg.maxAttempts,
        onLog: (m) => console.log("[crawl]", m),
      });
      hadItems = r.ok + r.requeued + r.failed + r.gaveup > 0;
      if (hadItems) console.log(`[crawl] cycle: ok ${r.ok} · recrawl ${r.requeued} · bỏ ${r.gaveup} · còn ~${r.remaining}`);
    } catch (e: any) {
      console.error("[crawl] ✗ cycle lỗi:", e?.message ?? e, "(Chrome 9222 còn mở không?)");
    }
    running = false;
    const wait = (hadItems ? cfg.intervalSeconds : cfg.idleSeconds) * 1000;
    timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, 5000);
  console.log(`⏰ Auto-crawl: BẬT (${cfg.batchSize} sp/cycle · nghỉ ${cfg.intervalSeconds}s · idle ${cfg.idleSeconds}s · CDP ${cfg.cdpUrl})`);
}

export function stopAutoCrawler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
