/**
 * Orchestrator: cào 1 sản phẩm SHEIN bằng Kiki profile (trình duyệt thật,
 * anti-detect → tránh captcha) và đẩy data vào pipeline cũ (baseSheinAutoDir).
 *
 * Lifecycle (theo zeroti): forceStop → startWithRetry → connectOverCDP →
 * mở page → goto → scrape → close → stopProfile.
 */
import { chromium } from "playwright-core";
import fs from "fs-extra";
import path from "path";
import { kiki } from "../services/kiki/client";
import { scrapeSheinProduct, type ScrapeOptions, type ScrapeResult } from "../services/kiki/sheinScraper";
import { ensureNoCaptcha, isCaptchaPresent, type CaptchaOptions } from "../services/kiki/captcha";
import { notifyCaptcha } from "../services/notification/telegram";
import { attachStatsCapture } from "../services/kiki/productStats";

/**
 * STRICT COUNT GATE: sau khi cào, nếu số variant XỬ LÝ ĐƯỢC ít hơn nhiều so với số swatch
 * trang có lúc đầu (sau "Show More") → loop bị bỏ swatch giữa chừng (captcha/timing) → CRAWL FAIL.
 *
 * processed = số màu cào ok + số màu xác định OOS. expected = swatches.length sau Show-More.
 * tolerance=1: chấp nhận thiếu 1 (lâu lâu 1 sp hết hàng nên bị bỏ khi click). Thiếu ≥2 → cào lại.
 * Sản phẩm ≤1 màu (không có swatch) bỏ qua check.
 */
function assertColorCount(data: ScrapeResult, tolerance = 1): void {
  const m: any = (data as any)?._meta || {};
  const expected: number | undefined = m.expectedColors;
  if (!expected || expected < 2) return;
  const oos = m.oosColors?.length || 0;
  const processed: number = m.processedColors ?? data.listing_variations.colors.length + oos;
  if (processed < expected - tolerance) {
    throw new Error(
      `Crawl fail: chỉ xử lý ${processed}/${expected} variant ` +
        `(cào ${data.listing_variations.colors.length} màu${oos ? ` + ${oos} OOS` : ""}) — ` +
        `thiếu quá nhiều (có thể captcha/timing bỏ swatch giữa chừng) → cào lại.`
    );
  }
}

export interface ScrapeViaKikiParams {
  url: string;
  profileId: string;
  options?: ScrapeOptions;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
}

export async function scrapeViaKiki(params: ScrapeViaKikiParams): Promise<ScrapeResult> {
  const { url, profileId, options, onLog } = params;
  const log = (m: string) => onLog?.(m);

  if (!/shein\./i.test(url)) throw new Error(`URL không phải SHEIN: ${url}`);

  log(`Force-stop profile ${profileId}…`);
  await kiki.forceStop(profileId);

  log(`Khởi động Kiki profile…`);
  const started = await kiki.startWithRetry(profileId, log);

  log(`Kết nối CDP (port ${started.debuggingPort})…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  let page: any;
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();

    // Bắt số liệu (sold/review/rating) từ BFF API — phải attach TRƯỚC khi goto
    const goodsId = url.match(/-p-(\d+)\.html/)?.[1];
    const statsCapture = attachStatsCapture(page, goodsId);

    log(`Mở ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);

    // Captcha: nếu xuất hiện → báo Telegram + chờ giải (thủ công trong cửa sổ Kiki)
    await ensureNoCaptcha(page, {
      ...params.captcha,
      onLog: log,
      context: `Cào sản phẩm: ${url.slice(0, 60)}`,
      profileId,
    });

    // Đợi sản phẩm SẴN SÀNG (poll ~24s). Sau khi giải captcha trang có thể reload → KHÔNG check 1 lần
    // rồi bỏ. Trong lúc chờ, nếu captcha TÁI XUẤT HIỆN → xử lại (chờ giải + báo Telegram).
    let hasProduct = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await isCaptchaPresent(page).catch(() => false)) {
        await ensureNoCaptcha(page, {
          ...params.captcha,
          onLog: log,
          context: `Cào (chờ sản phẩm load): ${url.slice(0, 55)}`,
          profileId,
        });
      }
      hasProduct = await page
        .locator(".product-intro__head-name, h1.product-intro__head-name")
        .first()
        .count()
        .catch(() => 0);
      if (hasProduct) break;
      await page.waitForTimeout(2000);
    }
    if (!hasProduct) {
      const title = await page.title().catch(() => "");
      throw new Error(
        `Không thấy nội dung sản phẩm sau 24s (captcha/chặn hoặc URL sai). Tiêu đề trang: "${title}"`
      );
    }

    log(`Đang cào…`);
    // Watcher SONG SONG: captcha bật GIỮA CHỪNG (lúc click variant) → bắn Telegram (scraper tự đợi giải).
    let watching = true;
    const captchaWatcher = (async () => {
      let wasPresent = false;
      while (watching) {
        await page.waitForTimeout(3000).catch(() => {});
        if (!watching) break;
        const present = await isCaptchaPresent(page).catch(() => false);
        if (present && !wasPresent) {
          log(`⚠️ Captcha GIỮA CHỪNG khi cào — báo Telegram, chờ giải thủ công.`);
          notifyCaptcha({
            context: `Cào SHEIN (giữa chừng): ${url.slice(0, 55)}`,
            profileId,
            url: (() => { try { return page.url(); } catch { return undefined; } })(),
          }).catch(() => {});
        }
        wasPresent = present;
      }
    })();

    const data = await scrapeSheinProduct(page, options);
    watching = false;
    await captchaWatcher.catch(() => {});
    // chờ 1 nhịp để realtime BFF kịp về (nếu chưa)
    await page.waitForTimeout(1500);
    statsCapture.detach();
    (data as any).stats = statsCapture.stats;
    // 🐞 Variant kẹt NẶNG (>=3 màu / >=30%) → data sai, báo lỗi để cào lại. Kẹt 1-2 màu lẻ thì chấp nhận.
    {
      const s: string[] = (data as any)?._meta?.stuckColors || [];
      const n = data.listing_variations.colors.length || 1;
      if (s.length >= Math.max(3, Math.ceil(n * 0.3))) {
        throw new Error(`Variant kẹt nặng (${s.length}/${n} màu: ${s.slice(0, 3).join(", ")}) → cào lại.`);
      }
    }
    // STRICT COUNT: thiếu quá nhiều variant so với lúc đầu (sau Show-More) → crawl fail.
    assertColorCount(data);
    const s = statsCapture.stats;
    log(
      `Cào xong: "${(data.product_name || "").slice(0, 50)}" · ${data.listing_variations.colors.length} màu · ${data.product_images.length} ảnh` +
        (s.soldText ? ` · sold ${s.soldText}` : "") +
        (s.reviewCount != null ? ` · ${s.reviewCount} review` : "") +
        (s.rating != null ? ` · ⭐${s.rating}` : "")
    );
    return data;
  } finally {
    try {
      if (page) await page.close();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile.`);
  }
}

export interface BatchItem { goodsId: string; url: string }
export interface ScrapeBatchParams {
  items: BatchItem[];
  profileId: string;
  options?: ScrapeOptions;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
  /** Gọi sau MỖI sp (để ghi JSON + mark crawled ngay → tiến độ không mất nếu gián đoạn). */
  onProduct?: (goodsId: string, data: ScrapeResult | null, error?: string) => Promise<void> | void;
}

/**
 * SESSION-REUSE: mở Kiki 1 LẦN, cào HẾT N sản phẩm trong CÙNG browser, đóng 1 lần.
 * → giảm captcha mạnh (session "ấm", ít bị challenge lại) + nhanh hơn (không restart profile mỗi sp).
 */
export async function scrapeBatchViaKiki(
  params: ScrapeBatchParams
): Promise<{ goodsId: string; ok: boolean; data?: ScrapeResult; error?: string }[]> {
  const { items, profileId, options, onLog, onProduct } = params;
  const log = (m: string) => onLog?.(m);
  const out: { goodsId: string; ok: boolean; data?: ScrapeResult; error?: string }[] = [];

  let browser: any;
  let page: any;

  // Mở 1 phiên Kiki MỚI (force-stop → start → CDP → page). Dùng cho phiên đầu + restart khi variant kẹt.
  const openSession = async (why: string) => {
    log(`${why} — Force-stop profile ${profileId}…`);
    await kiki.forceStop(profileId);
    const started = await kiki.startWithRetry(profileId, log);
    browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
  };
  const closeSession = async () => {
    try { if (page) await page.close(); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    page = undefined;
    browser = undefined;
  };

  // Tải URL + đợi sản phẩm + xử captcha + cào — dùng `page` của phiên hiện tại. Trả data (đã gắn stats).
  const loadAndScrape = async (it: BatchItem, idx: number): Promise<ScrapeResult> => {
    // Resilience: phiên trước chết → mở lại. Bắt CẢ 3 trạng thái: page=undefined (restart fail),
    //   page đã CLOSED (browser bị đóng giữa chừng), browser disconnect → tránh cascade "Target page closed".
    const dead =
      !page ||
      (typeof page.isClosed === "function" && page.isClosed()) ||
      (browser && typeof browser.isConnected === "function" && !browser.isConnected());
    if (dead) await openSession(`[${idx + 1}] Mở lại session (phiên trước chết/đóng)`);
    const goodsId = it.url.match(/-p-(\d+)\.html/)?.[1] || it.goodsId;
    log(`[${idx + 1}/${items.length}] Mở ${it.url.slice(0, 55)}`);
    const statsCapture = attachStatsCapture(page, goodsId);
    await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);

    // Đợi sản phẩm sẵn sàng + xử captcha (entry/reload) — tối đa ~24s.
    let hasProduct = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await isCaptchaPresent(page).catch(() => false)) {
        await ensureNoCaptcha(page, { ...params.captcha, onLog: log, context: `Cào batch: ${it.url.slice(0, 55)}`, profileId });
      }
      hasProduct = await page.locator(".product-intro__head-name, h1.product-intro__head-name").first().count().catch(() => 0);
      if (hasProduct) break;
      await page.waitForTimeout(2000);
    }
    if (!hasProduct) { statsCapture.detach(); throw new Error("Không thấy sản phẩm sau 24s (captcha/chặn)."); }

    log(`[${idx + 1}] Đang cào…`);
    // Captcha GIỮA lúc cào (click variant) → KHÔNG watcher/noti/xử lý (theo yêu cầu — đỡ giải tay nhiều);
    //   scraper tự click tiếp. Chỉ captcha lúc ĐẦU (wait-for-product ở trên) mới ensureNoCaptcha + noti Telegram.
    const data = await scrapeSheinProduct(page, options);
    await page.waitForTimeout(1500);
    statsCapture.detach();
    (data as any).stats = statsCapture.stats;
    return data;
  };

  await openSession(`Khởi động Kiki (1 phiên cho batch ${items.length} sp)`);
  try {
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      try {
        if (!/shein\./i.test(it.url)) throw new Error(`URL không phải SHEIN: ${it.url}`);
        let data = await loadAndScrape(it, idx);

        // 🐞 BUG VARIANT KẸT: click đổi màu nhưng ảnh KHÔNG đổi (SHEIN SPA chỉ đổi URL).
        //   Chỉ restart session khi kẹt NẶNG (>=3 màu hoặc >=30% số màu) — kẹt 1-2 màu lẻ thì
        //   chấp nhận (poll-đổi-ảnh đã lo phần lớn), tránh restart vô ích gây cascade/HTTP 500.
        const heavyStuck = (d: ScrapeResult): string[] => {
          const s: string[] = (d as any)?._meta?.stuckColors || [];
          const n = d.listing_variations.colors.length || 1;
          return s.length >= Math.max(3, Math.ceil(n * 0.3)) ? s : [];
        };
        let stuck = heavyStuck(data);
        if (stuck.length) {
          const n = data.listing_variations.colors.length;
          // TIER 1 (rẻ): reload trang trên CÙNG session (loadAndScrape goto lại) → reset SPA, KHÔNG đụng Kiki.
          log(`[${idx + 1}] ⚠️ VARIANT KẸT NẶNG (${stuck.length}/${n} màu: ${stuck.slice(0, 3).join(", ")}) → reload trang cào lại (cùng session)…`);
          data = await loadAndScrape(it, idx);
          stuck = heavyStuck(data);
          if (stuck.length) {
            // TIER 2 (đắt): vẫn kẹt → restart hẳn session (force-stop+start). Last resort.
            log(`[${idx + 1}] vẫn kẹt ${stuck.length} màu → restart hẳn session…`);
            await closeSession();
            await new Promise((r) => setTimeout(r, 3000)); // chờ Kiki giải phóng profile sau browser.close() → tránh start 500
            await openSession(`[${idx + 1}] Session MỚI (cào lại variant kẹt)`);
            data = await loadAndScrape(it, idx);
            if (heavyStuck(data).length) {
              throw new Error(`Variant VẪN kẹt nặng sau reload+restart (${heavyStuck(data).length} màu) → bỏ qua, để 'allocated' cào lại sau.`);
            }
          }
          log(`[${idx + 1}] ✅ Hết kẹt nặng — variant đã đổi ảnh đúng.`);
        } else if (((data as any)?._meta?.stuckColors || []).length) {
          const s: string[] = (data as any)._meta.stuckColors;
          log(`[${idx + 1}] ⚠️ ${s.length} màu kẹt nhẹ (${s.slice(0, 3).join(", ")}) — chấp nhận, không restart.`);
        }

        // STRICT COUNT: thiếu quá nhiều variant so với lúc đầu (sau Show-More) → crawl fail → onProduct(null,error).
        assertColorCount(data);

        log(`[${idx + 1}] Cào xong: "${(data.product_name || "").slice(0, 38)}" · ${data.listing_variations.colors.length} màu · ${data.product_images.length} ảnh`);
        out.push({ goodsId: it.goodsId, ok: true, data });
        if (onProduct) await onProduct(it.goodsId, data);
        await page.waitForTimeout(1200 + Math.floor(Math.random() * 900)); // pacing nhẹ giữa sp (giảm flag)
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(0, 160);
        log(`[${idx + 1}] ❌ ${error}`);
        out.push({ goodsId: it.goodsId, ok: false, error });
        if (onProduct) await onProduct(it.goodsId, null, error);
      }
    }
  } finally {
    await closeSession();
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile (batch xong: ${out.filter((r) => r.ok).length}/${items.length} ok).`);
  }
  return out;
}

/**
 * Kiểm data cào có HỎNG NẶNG không (thiếu trường sống-còn → chắc chắn fail lúc list).
 * Trả lý do nếu hỏng, null nếu OK. Dùng làm HARD GATE ở mọi path cào: hỏng → requeue recrawl,
 * KHÔNG ghi JSON vào hàng đợi listing (tránh case "Title rỗng vì product_name undefined").
 * KHÁC size_chart (soft — thiếu vẫn chấp nhận sau retry): các trường ở đây thiếu là fail chắc.
 */
export function hardScrapeError(data: any): string | null {
  if (!data) return "data rỗng";
  const name = String(data.product_name ?? "").trim();
  if (!name || name.toLowerCase() === "undefined" || name.toLowerCase() === "null") {
    return `product_name rỗng/không hợp lệ ("${data.product_name}")`;
  }
  const nImg = Array.isArray(data.product_images) ? data.product_images.length : 0;
  if (nImg === 0) return "0 ảnh (product_images rỗng)";
  const nColor = data.listing_variations?.colors?.length ?? 0;
  if (nColor === 0) return "0 màu (listing_variations.colors rỗng)";
  return null;
}

/**
 * Ghi data đã cào vào baseSheinAutoDir/<shop>/<shop>_<ts>.json — y như ingest,
 * để queueManager nhặt và publish lên 4Seller.
 */
export async function dispatchScrapedData(
  baseSheinAutoDir: string,
  data: any,
  shops: string[]
): Promise<{ shop: string; file: string }[]> {
  const timestamp = Date.now();
  const written: { shop: string; file: string }[] = [];
  for (const shop of shops) {
    if (/[\/\\]|\.\./.test(shop)) continue; // chặn path traversal
    const folderPath = path.join(baseSheinAutoDir, shop);
    await fs.ensureDir(folderPath);
    const fileName = `${shop}_${timestamp}.json`;
    await fs.writeFile(path.join(folderPath, fileName), JSON.stringify(data, null, 2), "utf-8");
    written.push({ shop, file: fileName });
  }
  return written;
}
