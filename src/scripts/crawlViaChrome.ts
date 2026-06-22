/**
 * crawlViaChrome — TEST: cào SHEIN bằng CHROME THẬT (connect qua CDP) để SO lỗi vs Kiki profile.
 * KHÔNG ghi DB / shop folder — chỉ ĐO metrics (ok/fail/entry-captcha/variant-stuck/thời gian).
 *
 * B1. Đóng HẾT Chrome đang mở, rồi mở Chrome bằng debug port + profile riêng (an toàn, không đụng profile chính):
 *     "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug-shein"
 *   (Lần đầu nên vào us.shein.com 1 lượt cho có cookie "người thật" rồi mới chạy test.)
 * B2. npx tsx src/scripts/crawlViaChrome.ts "RUTMAN" 10
 *   (lấy đúng N sp 'allocated'/'recrawl' của shop — y như crawlAllocated, để so apples-to-apples.)
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { scrapeSheinProduct } from "../services/kiki/sheinScraper";
import { ensureNoCaptcha, isCaptchaPresent } from "../services/kiki/captcha";

const CDP = process.env.CHROME_CDP || "http://localhost:9222";

const main = async () => {
  const argv = process.argv.slice(2);
  const n = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 5;
  const shopArg = argv.join(" ").trim();
  if (!shopArg) return console.log('Dùng: npx tsx src/scripts/crawlViaChrome.ts "RUTMAN" 10');

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const shopRow = db
    .prepare("SELECT DISTINCT shop FROM shop_allocation WHERE shop LIKE '%'||?||'%' LIMIT 1")
    .get(shopArg) as any;
  if (!shopRow) { db.close(); return console.log(`Không thấy shop "${shopArg}".`); }
  const items = db
    .prepare(
      `SELECT goods_id, name, url FROM shop_allocation
       WHERE shop=? AND status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
       ORDER BY opportunity_score DESC LIMIT ?`
    )
    .all(shopRow.shop, n) as any[];
  db.close();
  if (!items.length) return console.log(`Không có sp 'allocated' cho ${shopRow.shop}.`);

  console.log(`Connect Chrome CDP ${CDP} …`);
  const browser = await chromium.connectOverCDP(CDP).catch((e: any) => {
    console.log(`❌ Không connect được Chrome tại ${CDP}.`);
    console.log(`   → Mở Chrome với: chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug-shein"`);
    console.log(`   Lỗi: ${e?.message ?? e}`);
    return null;
  });
  if (!browser) return;
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();

  const t0 = Date.now();
  const results: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r: any = { goods: it.goods_id, name: (it.name || "").slice(0, 34) };
    const ts = Date.now();
    try {
      await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2500);
      r.entryCaptcha = await isCaptchaPresent(page).catch(() => false);
      if (r.entryCaptcha) await ensureNoCaptcha(page, { onLog: (m) => console.error("    " + m) });
      let has = 0;
      for (let a = 0; a < 12; a++) {
        has = await page.locator(".product-intro__head-name").first().count().catch(() => 0);
        if (has) break;
        await page.waitForTimeout(2000);
      }
      if (!has) throw new Error("Không thấy product sau 24s");
      const data = await scrapeSheinProduct(page, {});
      r.ok = true;
      r.colors = data.listing_variations.colors.length;
      r.stuck = (data as any)._meta?.stuckColors?.length || 0;
      r.sizeChart = !!data.size_chart;
      r.secs = Math.round((Date.now() - ts) / 1000);
      console.log(
        `[${i + 1}/${items.length}] ✅ ${r.name} · ${r.colors} màu · stuck ${r.stuck} · sizechart ${r.sizeChart ? "có" : "ko"} · ${r.secs}s${r.entryCaptcha ? " · (giải entry captcha)" : ""}`
      );
    } catch (e: any) {
      r.ok = false;
      r.error = String(e?.message ?? e).slice(0, 70);
      r.secs = Math.round((Date.now() - ts) / 1000);
      console.log(`[${i + 1}/${items.length}] ❌ ${r.name} · ${r.error} · ${r.secs}s`);
    }
    results.push(r);
    await page.waitForTimeout(1500);
  }
  await page.close().catch(() => {});
  // KHÔNG browser.close() — giữ Chrome của sếp mở.

  const ok = results.filter((r) => r.ok).length;
  const cap = results.filter((r) => r.entryCaptcha).length;
  const stuck = results.filter((r) => r.stuck > 0).length;
  const noSize = results.filter((r) => r.ok && !r.sizeChart).length;
  console.log(`\n=== KẾT QUẢ CÀO BẰNG CHROME THẬT (${shopRow.shop.replace("TA Scan ", "").replace("_US", "")}) ===`);
  console.log(`  OK: ${ok}/${results.length}  |  entry-captcha: ${cap}  |  có variant-stuck: ${stuck}  |  thiếu size_chart: ${noSize}`);
  console.log(`  Tổng thời gian: ${Math.round((Date.now() - t0) / 1000)}s (${results.length ? Math.round((Date.now() - t0) / 1000 / results.length) : 0}s/sp)`);
  const errs = results.filter((r) => !r.ok).map((r) => r.error);
  if (errs.length) console.log(`  Lỗi: ${[...new Set(errs)].join(" | ")}`);
};

main().catch((e) => console.log("ERR", e?.message ?? e));
