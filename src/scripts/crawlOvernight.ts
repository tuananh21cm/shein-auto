/**
 * crawlOvernight — CÀO TỰ ĐỘNG cả đêm qua CHROME (1 profile đã đăng nhập), chạy lặng lẽ.
 *
 * Hành vi (theo yêu cầu):
 *  - Cào liên tục, KHÔNG chờ giải captcha — cứ click xuyên qua cho hết listing (forceClick = JS click,
 *    ăn được cả khi có overlay captcha). Captcha chặn hẳn không load product → coi như FAIL.
 *  - Sau khi cào hết variant + mở size chart: CHECK đủ màu chưa (processedColors >= expectedColors).
 *  - Fail HOẶC thiếu màu → HOLD (status='recrawl') để lần sau cào lại. KHÔNG ghi JSON dở.
 *  - Đủ màu (và có size_chart, hoặc đã retry) → ghi JSON + status='crawled'.
 *  - Nghỉ ~3 phút giữa mỗi listing (CRAWL_DELAY_MS). Round-robin 5 shop SHEIN. Chạy tới khi hết.
 *
 * Usage: npx tsx src/scripts/crawlOvernight.ts [maxProducts]
 * Env:   CHROME_CDP (mặc định http://127.0.0.1:9222), CRAWL_DELAY_MS (mặc định 180000 = 3 phút).
 *
 * ⚠️ Giữ cửa sổ Chrome (--remote-debugging-port=9222) MỞ suốt đêm. Chạy DETACHED (Start-Process) để
 *    không bị giới hạn thời gian của shell.
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { config } from "../config";
import { scrapeSheinProduct } from "../services/kiki/sheinScraper";
import { attachStatsCapture } from "../services/kiki/productStats";
import { dispatchScrapedData, hardScrapeError } from "../core/scrapeViaKiki";

const CDP = process.env.CHROME_CDP || "http://127.0.0.1:9222";
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS) || 180_000; // 3 phút giữa các listing
const MAX_ATTEMPTS = 2; // số lần thử lại 1 sp TRONG 1 đêm (hết thì để 'recrawl' cho đêm sau)
const maxProducts = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : Infinity;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${ts()}] ${m}`);

const main = async () => {
  const baseDir = config.baseSheinAutoDir;
  if (!baseDir) { log("❌ BASE_SHEINAUTO_DIR chưa set."); return; }

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const shops: string[] = db.prepare("SELECT shop FROM shop_niche ORDER BY shop").all().map((r: any) => r.shop);
  if (!shops.length) { log("❌ Không có shop SHEIN trong shop_niche."); db.close(); return; }
  const markCrawled = db.prepare("UPDATE shop_allocation SET status='crawled' WHERE goods_id=? AND shop=?");
  const markRecrawl = db.prepare("UPDATE shop_allocation SET status='recrawl' WHERE goods_id=? AND shop=?");

  log(`🌙 BẮT ĐẦU cào đêm qua Chrome ${CDP}. ${shops.length} shop, nghỉ ${Math.round(DELAY_MS / 1000)}s/listing, tối đa ${maxProducts === Infinity ? "∞" : maxProducts} sp.`);

  let browser = await chromium.connectOverCDP(CDP);
  let ctx = browser.contexts()[0] ?? (await browser.newContext());
  let page = await ctx.newPage();

  const ensurePage = async () => {
    try {
      if (!browser.isConnected()) throw new Error("disconnected");
      if (!page || page.isClosed()) page = await ctx.newPage();
    } catch {
      log("🔌 Mất kết nối Chrome → reconnect…");
      for (;;) {
        try {
          browser = await chromium.connectOverCDP(CDP);
          ctx = browser.contexts()[0] ?? (await browser.newContext());
          page = await ctx.newPage();
          log("🔌 Reconnect Chrome OK.");
          break;
        } catch (e: any) {
          log(`🔌 Chrome chưa sẵn sàng (${e?.message ?? e}) — chờ 30s thử lại…`);
          await sleep(30_000);
        }
      }
    }
  };

  const attempts = new Map<string, number>(); // goodsId → số lần đã thử đêm nay
  const maxed = new Set<string>(); // goodsId đã thử >= MAX_ATTEMPTS

  // Lấy sp eligible kế tiếp của 1 shop (allocated trước, rồi recrawl), bỏ qua sp đã maxed.
  const nextForShop = (shop: string): any => {
    const rows = db.prepare(
      `SELECT goods_id, name, url, status FROM shop_allocation
       WHERE shop=? AND status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
       ORDER BY (status='allocated') DESC, opportunity_score DESC LIMIT 30`
    ).all(shop) as any[];
    return rows.find((r) => !maxed.has(String(r.goods_id)));
  };

  // Cào 1 sp qua Chrome — KHÔNG chờ captcha. Trả {ok, data?, reason?}.
  const crawlOne = async (url: string, goodsId: string): Promise<{ ok: boolean; data?: any; reason?: string }> => {
    // Thử tối đa 2 lần: lỗi "Execution context destroyed"/navigate (SHEIN redirect giữa scrape) → re-goto.
    for (let tryN = 1; tryN <= 2; tryN++) {
      await ensurePage();
      const statsCapture = attachStatsCapture(page, goodsId);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2500);
        // Đợi NGẮN cho product render (best-effort) — KHÔNG hold nếu captcha che. Captcha chỉ là overlay,
        // DOM product + swatch vẫn ở dưới → forceClick (JS click) ăn xuyên qua. Cứ SCRAPE, không chờ giải.
        for (let a = 0; a < 6; a++) {
          const has = await page.locator(".product-intro__head-name, h1.product-intro__head-name, .main-sales-attr__color-container").first().count().catch(() => 0);
          if (has) break;
          await page.waitForTimeout(1500);
        }
        const data = await scrapeSheinProduct(page, {});
        statsCapture.detach();
        (data as any).stats = statsCapture.stats;
        // Chỉ FAIL khi captcha chặn HẲN (page bị thay, không có product name LẪN màu nào).
        const got = !!(data.product_name && data.product_name.trim()) || (data.listing_variations?.colors?.length || 0) > 0;
        if (!got) return { ok: false, reason: "ko lấy được data (captcha chặn hẳn / page bị thay)" };
        return { ok: true, data };
      } catch (e: any) {
        statsCapture.detach();
        const msg = String(e?.message ?? e);
        // Lỗi navigate/context-destroyed → thử lại 1 lần (re-goto). Lỗi khác → fail luôn.
        if (tryN < 2 && /Execution context was destroyed|navigation|Target (page|closed)|detached|frame got detached/i.test(msg)) {
          await sleep(2500);
          continue;
        }
        return { ok: false, reason: msg.slice(0, 70) };
      }
    }
    return { ok: false, reason: "fail sau 2 lần thử" };
  };

  let done = 0, ok = 0, held = 0, shopIdx = 0;
  const exhausted = new Set<string>();

  while (done < maxProducts && exhausted.size < shops.length) {
    const shop = shops[shopIdx % shops.length];
    shopIdx++;
    if (exhausted.has(shop)) continue;

    const it = nextForShop(shop);
    if (!it) { exhausted.add(shop); continue; }

    const gid = String(it.goods_id);
    const att = (attempts.get(gid) || 0) + 1;
    attempts.set(gid, att);
    const shortShop = shop.replace("TA Scan ", "").replace("_US", "");
    const url = it.url;
    const r = await crawlOne(url, gid);
    done++;

    if (!r.ok) {
      markRecrawl.run(gid, shop);
      held++;
      if (att >= MAX_ATTEMPTS) maxed.add(gid);
      log(`❌ HOLD [${shortShop}] ${(it.name || "").slice(0, 34)} — ${r.reason} (thử ${att}/${MAX_ATTEMPTS})`);
    } else {
      const data = r.data;
      // HARD GATE: hỏng nặng (thiếu product_name/ảnh/màu) → recrawl, KHÔNG ghi JSON hỏng.
      const hard = hardScrapeError(data);
      if (hard) {
        markRecrawl.run(gid, shop);
        held++;
        if (att >= MAX_ATTEMPTS) maxed.add(gid);
        log(`⚠️ HOLD [${shortShop}] ${(it.name || "").slice(0, 30)} — hỏng: ${hard} (thử ${att}/${MAX_ATTEMPTS})`);
        continue;
      }
      const m = data._meta || {};
      const expected = m.expectedColors || 0;
      const processed = m.processedColors || 0;
      const complete = expected > 0 && processed >= expected;
      const sc = data.size_chart;
      const hasSize = !!(sc && ((sc.sections && sc.sections.length) || (sc.data && sc.data.length)));

      if (!complete) {
        markRecrawl.run(gid, shop);
        held++;
        if (att >= MAX_ATTEMPTS) maxed.add(gid);
        log(`⚠️ HOLD [${shortShop}] ${(data.product_name || "").slice(0, 30)} — THIẾU màu ${processed}/${expected} (thử ${att}/${MAX_ATTEMPTS})`);
      } else if (!hasSize && it.status !== "recrawl") {
        markRecrawl.run(gid, shop);
        held++;
        log(`⚠️ HOLD [${shortShop}] ${(data.product_name || "").slice(0, 30)} — đủ ${processed} màu nhưng thiếu size_chart → retry sau`);
      } else {
        await dispatchScrapedData(baseDir, data, [shop]);
        markCrawled.run(gid, shop);
        ok++;
        log(`✅ OK   [${shortShop}] ${(data.product_name || "").slice(0, 30)} — ${data.listing_variations.colors.length} màu, size_chart ${hasSize ? "có" : "KHÔNG (chấp nhận)"}`);
      }
    }

    if (done % 10 === 0) {
      const tot = db.prepare("SELECT COUNT(*) c FROM shop_allocation WHERE status='crawled' AND shop IN (SELECT shop FROM shop_niche)").get() as any;
      log(`── Tiến độ: đã thử ${done} sp đêm nay (✅ ${ok} ok, ⏸️ ${held} hold). TỔNG crawled toàn hệ: ${tot.c}.`);
    }

    if (done < maxProducts && exhausted.size < shops.length) await sleep(DELAY_MS);
  }

  const tot = db.prepare("SELECT COUNT(*) c FROM shop_allocation WHERE status='crawled' AND shop IN (SELECT shop FROM shop_niche)").get() as any;
  log(`🌅 XONG ĐÊM. Thử ${done} sp: ✅ ${ok} cào mới, ⏸️ ${held} hold (recrawl). TỔNG crawled toàn hệ: ${tot.c}.`);
  db.close();
  try { await page.close(); } catch { /* ignore */ }
  process.exit(0);
};

main().catch((e) => { log(`💥 LỖI: ${e?.message ?? e}`); process.exit(1); });
