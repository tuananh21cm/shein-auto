/**
 * Orchestrator: cào DANH SÁCH sản phẩm của nguyên 1 store SHEIN bằng Kiki.
 * Lifecycle: forceStop → start → connectOverCDP → mở storeUrl → warm-up →
 * crawlStore (scroll + intercept) → close → stop.
 */
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { crawlStore, type StoreProduct, type CrawlStoreOptions } from "../services/kiki/storeCrawler";
import { getStoreQuantity } from "../services/shein/client";
import type { CaptchaOptions } from "../services/kiki/captcha";

export interface CrawlStoreParams {
  /** store_code hoặc full storeUrl */
  store: string;
  profileId: string;
  maxProducts?: number;
  country?: string;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
}

export interface CrawlStoreResult {
  storeCode: string;
  storeUrl: string;
  quantity: number | null;
  products: StoreProduct[];
}

/** Resolve store_code + storeUrl từ input (code hoặc URL). */
async function resolveStore(input: string, country: string): Promise<{ storeCode: string; storeUrl: string; quantity: number | null }> {
  let storeCode = input.trim();
  const m = input.match(/store_code=(\d+)/) || input.match(/(\d{6,})/);
  if (m) storeCode = m[1];
  if (!/^\d+$/.test(storeCode)) throw new Error("Không nhận diện được store_code từ input");

  // Lấy storeUrl chuẩn từ API quantity (đang hoạt động)
  let storeUrl = "";
  let quantity: number | null = null;
  try {
    const q = await getStoreQuantity(storeCode, country);
    quantity = q.quantity;
    if (q.storeUrl) storeUrl = q.storeUrl;
  } catch {
    /* ignore — fallback dựng URL */
  }
  if (!storeUrl) {
    const host = country.toLowerCase() === "uk" ? "www.shein.co.uk" : "us.shein.com";
    storeUrl = `https://${host}/store/home?store_code=${storeCode}&type=selection`;
  }
  return { storeCode, storeUrl, quantity };
}

export async function crawlStoreViaKiki(params: CrawlStoreParams): Promise<CrawlStoreResult> {
  const { store, profileId, onLog } = params;
  const country = params.country ?? "us";
  const log = (m: string) => onLog?.(m);

  const { storeCode, storeUrl, quantity } = await resolveStore(store, country);
  log(`Store ${storeCode} · ${quantity ?? "?"} sp · ${storeUrl}`);

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

    // Warm-up: vào homepage trước cho "giống người" rồi mới vào store
    try {
      const home = new URL(storeUrl).origin;
      log(`Warm-up: ${home}`);
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 2000));
    } catch {
      /* bỏ qua warm-up lỗi */
    }

    log(`Mở store…`);
    await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    const opts: CrawlStoreOptions = {
      maxProducts: params.maxProducts ?? 300,
      captcha: { ...params.captcha, onLog: log, context: `Cào store ${storeCode}`, profileId },
      onLog: log,
    };
    const products = await crawlStore(page, opts);
    return { storeCode, storeUrl, quantity, products };
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
