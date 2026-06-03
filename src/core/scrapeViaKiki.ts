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
import { ensureNoCaptcha, type CaptchaOptions } from "../services/kiki/captcha";
import { attachStatsCapture } from "../services/kiki/productStats";

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

    // Phát hiện chặn/captcha thô: trang SHEIN sản phẩm phải có tên sản phẩm.
    const hasProduct = await page
      .locator(".product-intro__head-name, h1.product-intro__head-name")
      .first()
      .count()
      .catch(() => 0);
    if (!hasProduct) {
      const title = await page.title().catch(() => "");
      throw new Error(
        `Không thấy nội dung sản phẩm (có thể bị captcha/chặn hoặc URL sai). Tiêu đề trang: "${title}"`
      );
    }

    log(`Đang cào…`);
    const data = await scrapeSheinProduct(page, options);
    // chờ 1 nhịp để realtime BFF kịp về (nếu chưa)
    await page.waitForTimeout(1500);
    statsCapture.detach();
    (data as any).stats = statsCapture.stats;
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
