/**
 * Backend cào qua CHROME THẬT. 2 chế độ:
 *   - scrapeBatchViaChrome: connect CDP 1 Chrome đang mở (1 IP chung).
 *   - crawlBatchInContext: core — cào 1 batch trong 1 BrowserContext bất kỳ (dùng lại cho
 *     proxy-pool: mỗi context = 1 Chrome + 1 proxy riêng).
 * Giữ: captcha auto-X, captcha-block → HOLD 5p, variant-stuck reload, pacing giữa sp.
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { scrapeSheinProduct, type ScrapeOptions, type ScrapeResult } from "../services/kiki/sheinScraper";
import { scrapeSheinProductV2 } from "../services/kiki/sheinScraperV2";
import { dismissCaptcha, isCaptchaPresent, acceptCookies, type CaptchaOptions } from "../services/kiki/captcha";
import { warmUpHome, searchViaBox } from "./searchShein";

import { attachStatsCapture } from "../services/kiki/productStats";

/** Số vòng "về trang chủ → search lại" cho 1 sp. Vòng 1 gần như luôn trượt nên tối thiểu là 2. */
const SEARCH_ROUNDS = 3;

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
  params: Omit<ScrapeBatchChromeParams, "cdpUrl"> & { tag?: string; useV2?: boolean; failFastCaptcha?: boolean }
): Promise<BatchResult> {
  const { items, options, onLog, onProduct } = params;
  // V2 (ID-first, goto fresh-load từng màu) = MẶC ĐỊNH → hết bug "ảnh variant lệch"
  // (URL/màu đổi mà ảnh gallery không nhảy). V1 (click-swatch-in-page) chỉ khi ép useV2:false.
  const useV2 = params.useV2 ?? true;
  const tag = params.tag ? `${params.tag} ` : "";
  const log = (m: string) => onLog?.(tag + m);
  const out: BatchResult = [];
  let page = await ctx.newPage();

  // (Bỏ warm-up 1 lần/context: openViaSearch đã vào trang chủ + accept cookie ở MỖI vòng search.)

  const heavyStuck = (d: ScrapeResult): string[] => {
    const s: string[] = (d as any)?._meta?.stuckColors || [];
    const n = d.listing_variations.colors.length || 1;
    return s.length >= Math.max(3, Math.ceil(n * 0.3)) ? s : [];
  };

  /**
   * Mở trang sp QUA Ô TÌM KIẾM (trang chủ → gõ goods_id → bấm thẻ kết quả).
   * Goto THẲNG link `-p-<id>.html` dính captcha 100% (đo 24/09/2026: 20/20 IP, cả headed lẫn
   * headless, cả Chrome nguyên bản lẫn có fingerprint — chặn theo KIỂU TRUY CẬP, không theo IP).
   * Luồng search thì 6/6 sp cào được, và LẦN NÀO CŨNG trượt vòng 1, qua ở vòng 2 → phải lặp.
   */
  const openViaSearch = async (goodsId: string, idx: number): Promise<{ page: Page; stats: ReturnType<typeof attachStatsCapture> } | null> => {
    for (let round = 1; round <= SEARCH_ROUNDS; round++) {
      await warmUpHome(page, (m) => log(`[${idx + 1}] ${m}`));
      if (!(await searchViaBox(page, goodsId, (m) => log(`[${idx + 1}] ${m}`)))) continue;
      // Kết quả render sau điều hướng — không chờ là thấy trang rỗng rồi bỏ oan cả vòng.
      await page.waitForSelector('a[href*="-p-"]', { timeout: 15_000 }).catch(() => {});
      const exact = page.locator(`a[href*="-p-${goodsId}.html"]`);
      const card = (await exact.count().catch(() => 0)) ? exact.first() : page.locator('a[href*="-p-"]').first();
      if (!(await card.count().catch(() => 0))) { log(`[${idx + 1}] vòng ${round}: trang kết quả rỗng`); continue; }
      // Thẻ sp mở TAB MỚI. Đừng ép target=_self (SHEIN chặn, bấm xong không đi đâu — đo 24/09);
      // đón tab mới và gắn bộ bắt realtime_data ngay lúc tab sinh ra (trước khi response về).
      // Cuộn tới + hover trước khi bấm: thẻ ngoài viewport / ảnh lazy hay nuốt cú click đầu.
      await card.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
      await card.hover({ timeout: 5_000 }).catch(() => {});
      const popupP = ctx.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
      await card.click({ timeout: 15_000 }).catch(() => {});
      // Bấm hụt (không mở tab, không điều hướng) → bấm lại 1 lần nữa trước khi bỏ cả vòng.
      let popup = await Promise.race([popupP, page.waitForTimeout(6000).then(() => null)]);
      if (!popup && !/-p-\d+\.html/i.test(page.url())) {
        await card.click({ timeout: 10_000 }).catch(() => {});
        popup = await popupP;
      }
      const dp = popup ?? page; // vài lần SHEIN điều hướng ngay trong tab hiện tại
      const stats = attachStatsCapture(dp, goodsId);
      await dp.waitForURL(/-p-\d+\.html/i, { timeout: 15_000 }).catch(() => {});
      if (/\/risk\//i.test(dp.url())) {
        log(`[${idx + 1}] vòng ${round}: bấm sp → captcha, tìm lại`);
        stats.detach(); if (popup) await popup.close().catch(() => {});
        continue;
      }
      await dp.waitForSelector(".product-intro__head-name", { timeout: 20_000 }).catch(() => {});
      if (await dp.locator(".product-intro__head-name").first().count().catch(() => 0)) return { page: dp, stats };
      log(`[${idx + 1}] vòng ${round}: chưa vào được detail (${dp.url().slice(0, 45)})`);
      stats.detach(); if (popup) await popup.close().catch(() => {});
    }
    return null;
  };

  const loadAndScrape = async (it: ChromeBatchItem, idx: number): Promise<ScrapeResult> => {
    if (!page || page.isClosed()) { page = await ctx.newPage(); log(`[${idx + 1}] Page đã đóng → mở page mới.`); }
    const goodsId = it.url.match(/-p-(\d+)\.html/)?.[1] || it.goodsId;
    log(`[${idx + 1}/${items.length}] Tìm theo mã ${goodsId} (qua ô search)`);
    const opened = await openViaSearch(goodsId, idx);
    if (!opened) throw new Error(`__CAPTCHA_BLOCK__ ${SEARCH_ROUNDS} vòng search đều bị chặn`);
    const statsCapture = opened.stats;
    // Detail mở ở tab mới → tab search cũ thành rác; đóng và làm việc tiếp trên tab detail.
    if (opened.page !== page) { const old = page; page = opened.page; await old.close().catch(() => {}); }
    await page.waitForTimeout(2500);
    await acceptCookies(page, 2500).catch(() => false); // banner cookie trên trang product → accept để đỡ captcha
    const isGone = async (): Promise<boolean> =>
      !!(await page.evaluate(`(function(){var t=(document.body?document.body.innerText:'')||''; return /OOPS|BACK TO HOME|page (not found|doesn'?t exist)/i.test(t.slice(0,500));})()`).catch(() => false));
    let hasProduct = 0;
    let gone = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await isCaptchaPresent(page).catch(() => false)) await dismissCaptcha(page, log);
      hasProduct = await page.locator(".product-intro__head-name, h1.product-intro__head-name").first().count().catch(() => 0);
      if (hasProduct) break;
      if (await isGone()) { gone = true; break; } // sp đã gỡ (OOPS) → khỏi retry 24s
      await page.waitForTimeout(2000);
    }
    if (!hasProduct) {
      statsCapture.detach();
      const blocked = /risk\/challenge|\/captcha/i.test(page.url()) || (await isCaptchaPresent(page).catch(() => false));
      if (gone) throw new Error("Sản phẩm đã gỡ (OOPS/404).");
      throw new Error(blocked ? "__CAPTCHA_BLOCK__ captcha challenge chặn URL (/risk/challenge)" : "Không thấy sản phẩm sau 24s.");
    }
    log(`[${idx + 1}] Đang cào…${useV2 ? " (V2: goto fresh-load từng màu, ảnh không lệch)" : ""}`);
    const data = useV2
      ? await scrapeSheinProductV2(page, {
          ...options,
          onLog: log,
          // Mỗi màu là 1 goto fresh → có thể dính captcha per-load → auto-X ngay.
          onCaptcha: async (p) => { if (await isCaptchaPresent(p).catch(() => false)) await dismissCaptcha(p, log); },
        })
      : await scrapeSheinProduct(page, options);
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
          // Pool xoay-IP-mỗi-sp: captcha → BỎ IP này ngay (đừng hold 5p), sp cào lại bằng IP khác.
          if (params.failFastCaptcha) {
            log(`⛔ [${idx + 1}] captcha → bỏ IP này (sp cào lại IP khác sau).`);
            out.push({ goodsId: it.goodsId, ok: false, error: "captcha (đổi IP)" });
            if (onProduct) await onProduct(it.goodsId, null, "captcha (đổi IP)");
            break;
          }
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
