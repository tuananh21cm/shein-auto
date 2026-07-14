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
import { ensureChromeDebug } from "./chromeDebug";
import { isKidsProduct, isPackProduct } from "./research/fashionFilter";

/** Số sp uncrawl còn tồn (allocated/recrawl, có url). */
function countUncrawl(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) n FROM shop_allocation WHERE status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''"
  ).get() as any).n;
}

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

/** Chạy 1 cycle cào batchSize sp toàn shop.
 *  CÀO 1 LẦN / SP → phân phối cho MỌI shop đang chờ sp đó (1 sp list nhiều shop). KHÔNG cào
 *  SHEIN N lần (quan trọng cho anti-bot). Mark trạng thái theo TỪNG (goods_id, shop). */
export async function runCrawlCycle(opts: CrawlCycleOptions): Promise<CrawlCycleResult> {
  ensureSchema();
  const log = opts.onLog ?? (() => {});
  const db = getDb();

  // batchSize sản phẩm DISTINCT (không phải row) — mỗi sp cào 1 lần dù nhiều shop chờ.
  const products = db.prepare(
    `SELECT goods_id, MAX(url) url, MAX(status='recrawl') hasRecrawl, MAX(opportunity_score) opp
     FROM shop_allocation
     WHERE status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
     GROUP BY goods_id
     ORDER BY hasRecrawl DESC, opp DESC LIMIT ?`
  ).all(opts.batchSize) as any[];
  const remaining = (db.prepare(
    "SELECT COUNT(DISTINCT goods_id) n FROM shop_allocation WHERE status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''"
  ).get() as any).n;

  if (!products.length) return { ok: 0, requeued: 0, failed: 0, gaveup: 0, remaining: 0 };

  // Với mỗi sp: các shop đang chờ (allocated/recrawl) + số lần đã thử của từng shop.
  const pendingShops = db.prepare(
    "SELECT shop, crawl_attempts FROM shop_allocation WHERE goods_id=? AND status IN ('allocated','recrawl')"
  );
  const meta: Record<string, { shop: string; attempts: number }[]> = {};
  const baseDirByShop: Record<string, string | null> = {};
  for (const p of products) {
    const shops = pendingShops.all(String(p.goods_id)) as any[];
    meta[p.goods_id] = shops.map((s) => ({ shop: s.shop, attempts: s.crawl_attempts ?? 0 }));
    for (const s of shops) {
      if (s.shop in baseDirByShop) continue;
      const owner = await getShopOwner(s.shop);
      const dirs = owner ? await getUserDirsByName(owner) : null;
      baseDirByShop[s.shop] = dirs?.baseSheinAutoDir ?? null;
    }
  }

  // Mark theo (goods_id, shop) — KHÔNG đụng shop khác cùng sp.
  const markCrawled = db.prepare("UPDATE shop_allocation SET status='crawled' WHERE goods_id=? AND shop=?");
  const markRecrawl = db.prepare("UPDATE shop_allocation SET status='recrawl', crawl_attempts=? WHERE goods_id=? AND shop=?");
  const markFailed = db.prepare("UPDATE shop_allocation SET status='failed', crawl_attempts=? WHERE goods_id=? AND shop=?");
  const markKids = db.prepare("UPDATE shop_allocation SET status='excluded' WHERE goods_id=?");
  const insExcluded = db.prepare("INSERT OR IGNORE INTO excluded_products (goods_id, reason, excluded_at) VALUES (?, ?, ?)");

  const { scrapeBatchViaChrome } = await import("./scrapeViaChrome");
  const { dispatchScrapedData, hardScrapeError } = await import("./scrapeViaKiki");

  let ok = 0, requeued = 0, failed = 0, gaveup = 0;
  // Requeue 1 (goods_id, shop): tăng attempts, quá maxAttempts → failed.
  const requeueShop = (goodsId: string, shop: string, attempts0: number, why: string) => {
    const attempts = attempts0 + 1;
    if (attempts >= opts.maxAttempts) { markFailed.run(attempts, goodsId, shop); gaveup++; log(`🛑 ${goodsId}·${shop} bỏ (thử ${attempts} lần): ${why}`); }
    else { markRecrawl.run(attempts, goodsId, shop); requeued++; log(`⚠️ ${goodsId}·${shop} → recrawl (${attempts}/${opts.maxAttempts}): ${why}`); }
  };
  // Requeue MỌI shop đang chờ của 1 sp (khi lỗi/thiếu size dùng chung cho mọi shop).
  const requeueAll = (goodsId: string, why: string) => {
    for (const m of meta[goodsId] ?? []) requeueShop(goodsId, m.shop, m.attempts, why);
  };

  const batchItems = products.map((p) => ({ goodsId: String(p.goods_id), url: p.url }));
  const cfg = crawlConfig();
  const captchaHoldMs = (cfg.captchaHoldMinutes ?? 5) * 60_000;
  const onProduct = async (goodsId: string, data: any, error?: string) => {
      const shops = meta[goodsId] ?? [];
      if (!data) { failed++; requeueAll(goodsId, error || "scrape fail"); return; }
      // HARD GATE: data hỏng nặng (thiếu product_name/ảnh/màu) → chắc chắn fail lúc list →
      // requeue mọi shop, KHÔNG ghi JSON hỏng (tránh case "Title rỗng vì product_name undefined").
      const hard = hardScrapeError(data);
      if (hard) { requeueAll(goodsId, hard); return; }
      // KIDS GATE: dùng breadcrumb category (chuẩn nhất) + tên → hàng trẻ em thì LOẠI VĨNH VIỄN
      // mọi shop (excluded + excluded_products), KHÔNG ghi JSON/list. Chặn kids lọt lên listing.
      if (isKidsProduct(data.product_name, data.category)) {
        markKids.run(goodsId);
        insExcluded.run(goodsId, `kids: ${String(data.category || "").slice(0, 80)}`, Date.now());
        gaveup++;
        log(`🧒 ${goodsId} HÀNG KIDS (${String(data.category || "").slice(0, 45)}) → loại, không list`);
        return;
      }
      // PACK GATE: hàng bán theo pack (2-3pcs…) khó bán → LOẠI vĩnh viễn (tên detail chuẩn hơn tên harvest).
      if (isPackProduct(data.product_name)) {
        markKids.run(goodsId); // dùng chung: set status='excluded' mọi shop
        insExcluded.run(goodsId, `pack: ${String(data.product_name || "").slice(0, 80)}`, Date.now());
        gaveup++;
        log(`📦 ${goodsId} HÀNG PACK (${String(data.product_name || "").slice(0, 45)}) → loại, không list`);
        return;
      }
      // size_chart là thuộc tính SP (không theo shop) → kiểm 1 lần, thiếu thì requeue mọi shop.
      const sc = data.size_chart;
      const hasSize = !!(sc && ((sc.sections && sc.sections.length) || (sc.data && sc.data.length)));
      if (!hasSize) { requeueAll(goodsId, "thiếu size_chart"); return; }
      // Phân phối cho từng shop (data đã cào 1 lần).
      let dispatched = 0;
      for (const m of shops) {
        const baseDir = baseDirByShop[m.shop];
        if (!baseDir) { requeueShop(goodsId, m.shop, m.attempts, `shop ${m.shop} thiếu baseSheinAutoDir`); continue; }
        await dispatchScrapedData(baseDir, data, [m.shop]);
        markCrawled.run(goodsId, m.shop); ok++; dispatched++;
      }
      log(`✅ ${goodsId} OK · ${data.listing_variations?.colors?.length || 0} màu → ${dispatched} shop`);
  };

  // PROXY POOL (nhiều Chrome, mỗi cái 1 IP) nếu bật + có proxy; không thì Chrome đơn (CDP).
  if (cfg.useProxyPool) {
    const bridges = await ensurePoolBridges(cfg, log);
    if (bridges.length) {
      const { scrapeBatchViaProxyPool } = await import("./scrapeViaProxyPool");
      await scrapeBatchViaProxyPool({ items: batchItems, bridges, headless: cfg.headless ?? true, captchaHoldMs, onLog: log, onProduct });
    } else {
      log("⚠️ useProxyPool nhưng 0 proxy → fallback Chrome đơn.");
      await scrapeBatchViaChrome({ items: batchItems, cdpUrl: opts.cdpUrl, captchaHoldMs, onLog: log, onProduct });
    }
  } else {
    await scrapeBatchViaChrome({ items: batchItems, cdpUrl: opts.cdpUrl, captchaHoldMs, onLog: log, onProduct });
  }

  return { ok, requeued, failed, gaveup, remaining };
}

/* ============= Proxy bridge cache (bridge 1 lần, dùng lại mọi cycle) ============= */
let _bridges: import("./proxyPool").ProxyBridge[] | null = null;
async function ensurePoolBridges(cfg: any, log: (m: string) => void) {
  if (_bridges) return _bridges;
  const { loadProxies, startBridges } = await import("./proxyPool");
  try {
    const all = await loadProxies(cfg.proxyFile || "config/proxies.txt", cfg.proxyScheme || "socks5");
    const pick = all.slice(0, Math.max(1, cfg.concurrency ?? 4));
    log(`🌐 Proxy pool: ${all.length} proxy, dùng ${pick.length} (concurrency)…`);
    const { bridges } = await startBridges(pick, log);
    _bridges = bridges;
    log(`🌐 ${bridges.length} proxy sẵn sàng.`);
    return bridges;
  } catch (e: any) {
    log(`⚠️ Load proxy lỗi: ${String(e?.message ?? e)}`);
    _bridges = [];
    return _bridges;
  }
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
      ensureSchema();
      const pending = countUncrawl();
      if (pending > 0) {
        // Pool mode: Playwright tự launch Chrome/proxy. Chrome đơn: tự bật CDP 9222.
        const chrome = cfg.useProxyPool ? { ok: true } : await ensureChromeDebug(cfg.cdpUrl, (m) => console.log("[crawl]", m));
        if (!chrome.ok) {
          console.warn(`[crawl] ⏸️ Chưa bật được Chrome (${(chrome as any).error}) — còn ${pending} sp, thử lại sau.`);
        } else {
          const r = await runCrawlCycle({
            batchSize: cfg.batchSize,
            cdpUrl: cfg.cdpUrl,
            maxAttempts: cfg.maxAttempts,
            onLog: (m) => console.log("[crawl]", m),
          });
          hadItems = r.ok + r.requeued + r.failed + r.gaveup > 0;
          if (hadItems) console.log(`[crawl] cycle: ok ${r.ok} · recrawl ${r.requeued} · bỏ ${r.gaveup} · còn ~${r.remaining}`);
        }
      }
    } catch (e: any) {
      console.error("[crawl] ✗ cycle lỗi:", e?.message ?? e, "(Chrome CDP còn mở không?)");
    }
    running = false;
    // Còn hàng (vừa cào hoặc đang chờ Chrome) → nghỉ ngắn; hết hàng → idle dài.
    const more = hadItems || countUncrawl() > 0;
    const wait = (more ? cfg.intervalSeconds : cfg.idleSeconds) * 1000;
    timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, 5000);
  console.log(`⏰ Auto-crawl: BẬT (${cfg.batchSize} sp/cycle · nghỉ ${cfg.intervalSeconds}s · idle ${cfg.idleSeconds}s · CDP ${cfg.cdpUrl})`);
}

export function stopAutoCrawler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
