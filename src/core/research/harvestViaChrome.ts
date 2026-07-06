/**
 * harvestViaChrome — vào SHEIN SEARCH bằng Chrome (CDP), intercept JSON sản phẩm qua
 * `crawlStore`, gom link+chỉ số (goodsId/name/price/reviewCount/rating) theo bộ keyword.
 * Tự bật Chrome qua ensureChromeDebug. KHÔNG chấm điểm ở đây (để orchestrator lo).
 */
import { chromium } from "playwright-core";
import { crawlStore, type StoreProduct } from "../../services/kiki/storeCrawler";
import { ensureChromeDebug } from "../chromeDebug";

export interface HarvestChromeOptions {
  cdpUrl: string;
  maxPerKeyword?: number;   // sp tối đa gom mỗi keyword (default 60)
  onLog?: (m: string) => void;
}

/** Search lần lượt các keyword trên SHEIN qua Chrome, trả sp DISTINCT (dedup goodsId). */
export async function harvestKeywordsViaChrome(
  keywords: string[],
  opts: HarvestChromeOptions
): Promise<StoreProduct[]> {
  const log = opts.onLog ?? (() => {});
  const chrome = await ensureChromeDebug(opts.cdpUrl, (m) => log(m));
  if (!chrome.ok) throw new Error(`Chrome chưa bật được: ${chrome.error}`);

  const browser = await chromium.connectOverCDP(opts.cdpUrl);
  const all = new Map<string, StoreProduct>();
  let page: any;
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    for (const kw of keywords) {
      const url = `https://us.shein.com/pdsearch/${encodeURIComponent(kw)}/`;
      log(`🔎 SHEIN search "${kw}"`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);
        const prods = await crawlStore(page, { maxProducts: opts.maxPerKeyword ?? 60, onLog: (m) => log("   " + m) });
        let fresh = 0;
        for (const p of prods) {
          if (p.goodsId && !all.has(p.goodsId)) { all.set(p.goodsId, p); fresh++; }
        }
        log(`   → ${prods.length} sp (${fresh} mới) · tổng gom ${all.size}`);
      } catch (e: any) {
        log(`   ⚠️ "${kw}" lỗi: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
  } finally {
    try { if (page) await page.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }
  return [...all.values()];
}
