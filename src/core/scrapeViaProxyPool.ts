/**
 * scrapeViaProxyPool — cào 1 batch bằng NHIỀU Chrome song song, MỖI Chrome 1 PROXY (IP riêng)
 * → chia tải, captcha không dồn vào 1 IP. Mỗi worker = Playwright launchPersistentContext
 * (profile riêng + proxy local từ proxy-chain). Dùng lại crawlBatchInContext.
 */
import { chromium, type BrowserContext } from "playwright-core";
import path from "path";
import { crawlBatchInContext, type ChromeBatchItem, type BatchResult } from "./scrapeViaChrome";
import type { ScrapeOptions, ScrapeResult } from "../services/kiki/sheinScraper";
import type { ProxyBridge } from "./proxyPool";

export interface ProxyPoolParams {
  items: ChromeBatchItem[];
  bridges: ProxyBridge[];
  userDataDirBase?: string;
  headless?: boolean;
  options?: ScrapeOptions;
  captchaHoldMs?: number;
  onLog?: (m: string) => void;
  onProduct?: (goodsId: string, data: ScrapeResult | null, error?: string) => Promise<void> | void;
}

/** Chia round-robin thành n chunk (cân bằng). */
function splitRoundRobin<T>(arr: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  arr.forEach((it, i) => out[i % n].push(it));
  return out;
}

export async function scrapeBatchViaProxyPool(params: ProxyPoolParams): Promise<BatchResult> {
  const log = params.onLog ?? (() => {});
  const bridges = params.bridges;
  if (!bridges.length) throw new Error("Không có proxy bridge.");
  const base = params.userDataDirBase || "C:\\chrome-proxy-shein";
  const chunks = splitRoundRobin(params.items, bridges.length);
  log(`Pool ${bridges.length} Chrome/proxy · ${params.items.length} sp → chia ${chunks.map((c) => c.length).join("/")}`);

  const results = await Promise.all(
    bridges.map(async (bridge, i): Promise<BatchResult> => {
      const items = chunks[i];
      if (!items.length) return [];
      const dir = path.join(base, `w${i}`);
      const tag = `[P${i}]`;
      let ctx: BrowserContext | undefined;
      try {
        ctx = await chromium.launchPersistentContext(dir, {
          headless: params.headless ?? true,
          proxy: { server: bridge.local },
          viewport: { width: 1366, height: 900 },
          args: ["--disable-blink-features=AutomationControlled"],
        });
        log(`${tag} ${bridge.label} · mở, cào ${items.length} sp`);
        return await crawlBatchInContext(ctx, {
          items,
          options: params.options,
          captchaHoldMs: params.captchaHoldMs,
          onLog: params.onLog,
          onProduct: params.onProduct,
          tag,
        });
      } catch (e: any) {
        log(`${tag} ✗ lỗi worker: ${String(e?.message ?? e).slice(0, 80)}`);
        return items.map((it) => ({ goodsId: it.goodsId, ok: false, error: `proxy worker lỗi: ${e?.message}` }));
      } finally {
        try { if (ctx) await ctx.close(); } catch { /* ignore */ }
      }
    })
  );
  return results.flat();
}
