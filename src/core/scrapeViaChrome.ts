/**
 * Backend cào qua CHROME THẬT. 2 chế độ:
 *   - scrapeBatchViaChrome: connect CDP 1 Chrome đang mở (1 IP chung).
 *   - crawlBatchInContext: core — cào 1 batch trong 1 BrowserContext bất kỳ (dùng lại cho
 *     proxy-pool: mỗi context = 1 Chrome + 1 proxy riêng).
 * Giữ: captcha auto-X, captcha-block → HOLD 5p, variant-stuck reload, pacing giữa sp.
 */
import { chromium, type BrowserContext } from "playwright-core";
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
  /** Gặp captcha challenge (/risk/challenge) → hold bao lâu rồi thử lại. Mặc định 5 phút. */
  captchaHoldMs?: number;
  onLog?: (msg: string) => void;
  onProduct?: (goodsId: string, data: ScrapeResult | null, error?: string) => Promise<void> | void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type BatchResult = { goodsId: string; ok: boolean; data?: ScrapeResult; error?: string }[];

/** CORE: cào batch trong 1 BrowserContext (CDP hoặc persistentContext-có-proxy). */
export async function crawlBatchInContext(
  ctx: BrowserContext,
  params: Omit<ScrapeBatchChromeParams, "cdpUrl"> & { tag?: string }
): Promise<BatchResult> {
  const { items, options, onLog, onProduct } = params;
  const tag = params.tag ? `${params.tag} ` : "";
  const log = (m: string) => onLog?.(tag + m);
  const out: BatchResult = [];
  let page = await ctx.newPage();

  const heavyStuck = (d: ScrapeResult): string[] => {
    const s: string[] = (d as any)?._meta?.stuckColors || [];
    const n = d.listing_variations.colors.length || 1;
    return s.length >= Math.max(3, Math.ceil(n * 0.3)) ? s : [];
  };

  const loadAndScrape = async (it: ChromeBatchItem, idx: number): Promise<ScrapeResult> => {
    if (!page || page.isClosed()) { page = await ctx.newPage(); log(`[${idx + 1}] Page đã đóng → mở page mới.`); }
    const goodsId = it.url.match(/-p-(\d+)\.html/)?.[1] || it.goodsId;
    log(`[${idx + 1}/${items.length}] Mở ${it.url.slice(0, 55)}`);
    const statsCapture = attachStatsCapture(page, goodsId);
    await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);
    let hasProduct = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await isCaptchaPresent(page).catch(() => false)) await dismissCaptcha(page, log);
      hasProduct = await page.locator(".product-intro__head-name, h1.product-intro__head-name").first().count().catch(() => 0);
      if (hasProduct) break;
      await page.waitForTimeout(2000);
    }
    if (!hasProduct) {
      statsCapture.detach();
      const blocked = /risk\/challenge|\/captcha/i.test(page.url()) || (await isCaptchaPresent(page).catch(() => false));
      throw new Error(blocked ? "__CAPTCHA_BLOCK__ captcha challenge chặn URL (/risk/challenge)" : "Không thấy sản phẩm sau 24s.");
    }
    log(`[${idx + 1}] Đang cào…`);
    const data = await scrapeSheinProduct(page, options);
    await page.waitForTimeout(1200);
    statsCapture.detach();
    (data as any).stats = statsCapture.stats;
    return data;
  };

  const holdMs = params.captchaHoldMs ?? 5 * 60 * 1000;
  const holdMin = Math.max(1, Math.round(holdMs / 60000));
  let stopBatch = false;
  try {
    for (let idx = 0; idx < items.length && !stopBatch; idx++) {
      const it = items[idx];
      try {
        if (!/shein\./i.test(it.url)) throw new Error(`URL không phải SHEIN: ${it.url}`);
        let data: ScrapeResult;
        try {
          data = await loadAndScrape(it, idx);
        } catch (eCap: any) {
          if (!String(eCap?.message ?? "").includes("__CAPTCHA_BLOCK__")) throw eCap;
          log(`🛑 [${idx + 1}] Captcha challenge → HOLD ${holdMin} phút cho SHEIN nguội…`);
          await sleep(holdMs);
          log(`▶ [${idx + 1}] Hết hold ${holdMin}p — thử lại sp…`);
          try {
            data = await loadAndScrape(it, idx);
          } catch (eCap2: any) {
            if (String(eCap2?.message ?? "").includes("__CAPTCHA_BLOCK__")) {
              log(`🛑 SHEIN VẪN chặn captcha sau hold → dừng batch, cycle sau thử lại.`);
              stopBatch = true;
              out.push({ goodsId: it.goodsId, ok: false, error: "captcha block sau hold" });
              if (onProduct) await onProduct(it.goodsId, null, "captcha block sau hold");
              break;
            }
            throw eCap2;
          }
        }
        if (heavyStuck(data).length) {
          const stuck = heavyStuck(data);
          log(`[${idx + 1}] ⚠️ VARIANT KẸT NẶNG (${stuck.length} màu) → reload cào lại…`);
          data = await loadAndScrape(it, idx);
          if (heavyStuck(data).length) throw new Error(`Variant VẪN kẹt nặng sau reload → để 'allocated' cào lại sau.`);
        }
        log(`[${idx + 1}] Cào xong: "${(data.product_name || "").slice(0, 38)}" · ${data.listing_variations.colors.length} màu`);
        out.push({ goodsId: it.goodsId, ok: true, data });
        if (onProduct) await onProduct(it.goodsId, data);
        await page.waitForTimeout(3500 + Math.floor(Math.random() * 3500));
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(0, 160);
        log(`[${idx + 1}] ❌ ${error}`);
        out.push({ goodsId: it.goodsId, ok: false, error });
        if (onProduct) await onProduct(it.goodsId, null, error);
      }
    }
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
  return out;
}

/** CDP path: connect 1 Chrome đang mở, cào cả batch (1 IP). */
export async function scrapeBatchViaChrome(params: ScrapeBatchChromeParams): Promise<BatchResult> {
  const { cdpUrl, onLog } = params;
  const log = (m: string) => onLog?.(m);
  log(`Connect Chrome CDP ${cdpUrl} (1 profile chung cho ${params.items.length} sp)…`);
  const browser = await chromium.connectOverCDP(cdpUrl).catch((e: any) => {
    throw new Error(`Không connect được Chrome tại ${cdpUrl} — mở Chrome với --remote-debugging-port=9222. (${e?.message ?? e})`);
  });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const out = await crawlBatchInContext(ctx, params);
  log(`Batch xong: ${out.filter((r) => r.ok).length}/${params.items.length} ok.`);
  return out;
}
