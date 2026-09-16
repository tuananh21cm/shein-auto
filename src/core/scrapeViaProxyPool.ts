/**
 * scrapeViaProxyPool — cào 1 batch bằng NHIỀU Chrome song song, MỖI Chrome 1 PROXY (IP riêng)
 * → chia tải, captcha không dồn vào 1 IP. Mỗi worker = Playwright launchPersistentContext
 * (profile riêng + proxy local từ proxy-chain). Dùng lại crawlBatchInContext.
 */
import { chromium, type Browser } from "playwright-core";
import { crawlBatchInContext, type ChromeBatchItem, type BatchResult } from "./scrapeViaChrome";
import type { ScrapeOptions, ScrapeResult } from "../services/kiki/sheinScraper";
import type { ProxyBridge } from "./proxyPool";
import { newFingerprint, fpContextOptions, applyFingerprint } from "./fingerprint";

export interface ProxyPoolParams {
  items: ChromeBatchItem[];
  bridges: ProxyBridge[];
  userDataDirBase?: string;
  headless?: boolean;
  options?: ScrapeOptions;
  captchaHoldMs?: number;
  concurrency?: number; // số Chrome chạy SONG SONG (proxy xoay theo từng sp, không giới hạn bởi số này)
  onLog?: (m: string) => void;
  onProduct?: (goodsId: string, data: ScrapeResult | null, error?: string) => Promise<void> | void;
}

/**
 * Cào batch: MỖI SẢN PHẨM 1 Chrome + 1 PROXY MỚI (xoay IP+fingerprint liên tục) → không dồn
 * tải 1 IP → tránh captcha/risk-limit khi cào nhiều sp. Chạy tối đa `concurrency` sp song song.
 * Captcha 1 sp → crawlBatchInContext fail-fast (không hold), sp đó cycle sau cào lại bằng IP khác.
 */
export async function scrapeBatchViaProxyPool(params: ProxyPoolParams): Promise<BatchResult> {
  const log = params.onLog ?? (() => {});
  const bridges = params.bridges;
  if (!bridges.length) throw new Error("Không có proxy bridge.");
  const par = Math.max(1, Math.min(params.concurrency ?? 3, bridges.length, params.items.length));
  log(`Pool ${bridges.length} proxy · ${params.items.length} sp · ${par} song song · MỖI sp 1 IP+browser MỚI (ephemeral, không session cũ)`);

  const out: BatchResult = [];
  let idx = 0;
  let rot = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const my = idx++;
      if (my >= params.items.length) break;
      const it = params.items[my];
      const bridge = bridges[(rot++) % bridges.length]; // xoay proxy theo từng sp
      let browser: Browser | undefined;
      try {
        const fp = newFingerprint();
        const fpOpts = fpContextOptions(fp);
        // EPHEMERAL (không userDataDir) → mỗi sp browser SẠCH: không cookie/session cũ, không dialog "Restore pages".
        browser = await chromium.launch({
          headless: params.headless ?? false,
          proxy: { server: bridge.local },
          args: ["--disable-blink-features=AutomationControlled"],
        });
        const ctx = await browser.newContext({ ...fpOpts });
        await applyFingerprint(ctx, fp);
        const r = await crawlBatchInContext(ctx, {
          items: [it],
          options: params.options,
          captchaHoldMs: 0,
          failFastCaptcha: true, // captcha → bỏ IP ngay (đừng hold), sp cào lại bằng IP khác
          useV2: false, // V1 = click variant IN-SESSION, KHÔNG reload/màu → ít captcha hơn hẳn V2 (goto/màu)
          onLog: params.onLog,
          onProduct: params.onProduct,
          tag: `[${bridge.label.slice(-14)}]`,
        });
        out.push(...r);
      } catch (e: any) {
        log(`[sp${my}] ✗ ${String(e?.message ?? e).slice(0, 70)}`);
        out.push({ goodsId: it.goodsId, ok: false, error: String(e?.message ?? e).slice(0, 120) });
        if (params.onProduct) await params.onProduct(it.goodsId, null, "proxy worker lỗi");
      } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
      }
    }
  };
  await Promise.all(Array.from({ length: par }, () => worker()));
  return out;
}
