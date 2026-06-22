/**
 * Backend cào qua CHROME THẬT (connect CDP) thay cho Kiki — TẠM THỜI để test.
 * Khác Kiki: KHÔNG quản lý profile (force-stop/start), chỉ connect 1 Chrome đang mở (1 profile chung),
 *   mở 1 page, cào hết batch, đóng page (giữ Chrome mở). Vẫn giữ: entry-captcha noti, variant-stuck
 *   reload, pacing giữa sp. onProduct y hệt Kiki path → ghi JSON + mark crawled/recrawl bình thường.
 *
 * Bật bằng: CRAWL_BACKEND=chrome (env) hoặc cờ --chrome cho crawlAllocated. CDP: CHROME_CDP (mặc định :9222).
 */
import { chromium } from "playwright-core";
import { scrapeSheinProduct, type ScrapeOptions, type ScrapeResult } from "../services/kiki/sheinScraper";
import { dismissCaptcha, isCaptchaPresent, type CaptchaOptions } from "../services/kiki/captcha";
import { attachStatsCapture } from "../services/kiki/productStats";

export interface ChromeBatchItem {
  goodsId: string;
  url: string;
}
export interface ScrapeBatchChromeParams {
  items: ChromeBatchItem[];
  cdpUrl: string;
  options?: ScrapeOptions;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
  onProduct?: (goodsId: string, data: ScrapeResult | null, error?: string) => Promise<void> | void;
}

export async function scrapeBatchViaChrome(
  params: ScrapeBatchChromeParams
): Promise<{ goodsId: string; ok: boolean; data?: ScrapeResult; error?: string }[]> {
  const { items, cdpUrl, options, onLog, onProduct } = params;
  const log = (m: string) => onLog?.(m);
  const out: { goodsId: string; ok: boolean; data?: ScrapeResult; error?: string }[] = [];

  log(`Connect Chrome CDP ${cdpUrl} (1 profile chung cho cả batch ${items.length} sp)…`);
  const browser = await chromium.connectOverCDP(cdpUrl).catch((e: any) => {
    throw new Error(`Không connect được Chrome tại ${cdpUrl} — mở Chrome với --remote-debugging-port=9222. (${e?.message ?? e})`);
  });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  let page = await ctx.newPage();

  const heavyStuck = (d: ScrapeResult): string[] => {
    const s: string[] = (d as any)?._meta?.stuckColors || [];
    const n = d.listing_variations.colors.length || 1;
    return s.length >= Math.max(3, Math.ceil(n * 0.3)) ? s : [];
  };

  const loadAndScrape = async (it: ChromeBatchItem, idx: number): Promise<ScrapeResult> => {
    // Resilience: page bị đóng (sếp đóng tab / Chrome crash tab) → mở page MỚI, tránh cascade "Target page closed".
    if (!page || page.isClosed()) {
      page = await ctx.newPage();
      log(`[${idx + 1}] Page đã đóng → mở page mới.`);
    }
    const goodsId = it.url.match(/-p-(\d+)\.html/)?.[1] || it.goodsId;
    log(`[${idx + 1}/${items.length}] Mở ${it.url.slice(0, 55)}`);
    const statsCapture = attachStatsCapture(page, goodsId);
    await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);

    // Captcha → TỰ X (đóng) rồi cào tiếp. KHÔNG chờ giải tay, KHÔNG noti Telegram (theo yêu cầu).
    // Captcha giữa lúc cào → scraper tự click xuyên qua.
    let hasProduct = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await isCaptchaPresent(page).catch(() => false)) {
        await dismissCaptcha(page, log);
      }
      hasProduct = await page.locator(".product-intro__head-name, h1.product-intro__head-name").first().count().catch(() => 0);
      if (hasProduct) break;
      await page.waitForTimeout(2000);
    }
    if (!hasProduct) { statsCapture.detach(); throw new Error("Không thấy sản phẩm sau 24s (captcha chặn URL — đã thử X)."); }

    log(`[${idx + 1}] Đang cào…`);
    const data = await scrapeSheinProduct(page, options);
    await page.waitForTimeout(1200);
    statsCapture.detach();
    (data as any).stats = statsCapture.stats;
    return data;
  };

  try {
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      try {
        if (!/shein\./i.test(it.url)) throw new Error(`URL không phải SHEIN: ${it.url}`);
        let data = await loadAndScrape(it, idx);

        // Variant kẹt nặng → reload trang cào lại 1 lần (Chrome không restart session như Kiki).
        if (heavyStuck(data).length) {
          const stuck = heavyStuck(data);
          log(`[${idx + 1}] ⚠️ VARIANT KẸT NẶNG (${stuck.length} màu: ${stuck.slice(0, 3).join(", ")}) → reload cào lại…`);
          data = await loadAndScrape(it, idx);
          if (heavyStuck(data).length) throw new Error(`Variant VẪN kẹt nặng sau reload → bỏ qua, để 'allocated' cào lại sau.`);
          log(`[${idx + 1}] ✅ Hết kẹt sau reload.`);
        }

        log(`[${idx + 1}] Cào xong: "${(data.product_name || "").slice(0, 38)}" · ${data.listing_variations.colors.length} màu · ${data.product_images.length} ảnh`);
        out.push({ goodsId: it.goodsId, ok: true, data });
        if (onProduct) await onProduct(it.goodsId, data);
        // Delay GIỮA sản phẩm (3.5–7s) → cào chậm như người, giảm kích captcha entry.
        await page.waitForTimeout(3500 + Math.floor(Math.random() * 3500));
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(0, 160);
        log(`[${idx + 1}] ❌ ${error}`);
        out.push({ goodsId: it.goodsId, ok: false, error });
        if (onProduct) await onProduct(it.goodsId, null, error);
        // Nếu page chết (Chrome đóng tab) → mở lại page để sp sau còn chạy.
        if (/Target page|context or browser has been closed/i.test(error)) {
          try { if (page.isClosed()) { /* reopen */ } } catch { /* ignore */ }
        }
      }
    }
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    // KHÔNG browser.close() — giữ Chrome của sếp mở.
    log(`Đã đóng page (Chrome vẫn mở). Batch xong: ${out.filter((r) => r.ok).length}/${items.length} ok.`);
  }
  return out;
}
