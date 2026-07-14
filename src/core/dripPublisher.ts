/**
 * dripPublisher — publish draft 4Seller nhỏ giọt để TRÁNH bị đánh điểm hành vi bất thường.
 *
 * Mỗi CYCLE: duyệt từng shop → publish perShopPerCycle draft (mặc định 1) trên cùng →
 * jitter ngắn giữa các shop. Hết cycle → chờ random intervalMin-Max phút → cycle kế.
 * Dừng khi mọi shop hết draft.
 *
 * Dùng API 4Seller (POST /api/listing/tiktok/batch-publish [id]) — không cần mở browser.
 */
import { getShopList, getDraftPage, batchPublish, type FourSellerShop } from "../services/fourseller/client";
import { publishConfig } from "../config/appConfig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Random ms trong [minMin, maxMin] phút. */
export function randMs(minMin: number, maxMin: number): number {
  const lo = Math.max(0, minMin) * 60_000;
  const hi = Math.max(minMin, maxMin) * 60_000;
  return Math.floor(lo + Math.random() * (hi - lo));
}

function jitterMs(minSec: number, maxSec: number): number {
  return Math.floor((minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000);
}

export interface DripOptions {
  cookieUser: string;
  perShopPerCycle?: number;
  interShopJitterSec?: [number, number];
  shopFilter?: (s: FourSellerShop) => boolean;
  onLog?: (m: string) => void;
}

export interface DripCycleResult {
  published: number;
  perShop: Record<string, number>;
  remaining: number; // tổng draft còn lại sau cycle (ước lượng)
}

/** Chạy 1 cycle: publish top N draft mỗi shop. */
export async function runDripCycle(opts: DripOptions): Promise<DripCycleResult> {
  const log = opts.onLog ?? (() => {});
  const per = opts.perShopPerCycle ?? 1;
  const jit = opts.interShopJitterSec ?? [30, 90];

  const shopResp = await getShopList(opts.cookieUser);
  const shops = shopResp?.records ?? [];
  const list = opts.shopFilter ? shops.filter(opts.shopFilter) : shops;
  let published = 0;
  let remaining = 0;
  const perShop: Record<string, number> = {};

  for (const shop of list) {
    try {
      // 4Seller trả data=null khi shop không còn draft (hoặc shop đóng) → coi như 0 draft.
      const resp = await getDraftPage(opts.cookieUser, { shopId: shop.id });
      const all = (resp?.records ?? []) as any[];
      // CHỈ publish draft đang "publishable". Draft "publishing" (đang publish dở) → batch-publish
      // báo "status does not support modification" → nếu lấy nhầm sẽ KẸT vĩnh viễn ở draft đầu.
      const drafts = all.filter((d) => d.publishStatus === "publishable" || !d.publishStatus);
      if (!drafts.length) {
        const stuck = all.filter((d) => d.publishStatus === "publishing").length;
        if (stuck) log(`  ⏳ ${shop.shopName}: ${stuck} draft đang 'publishing', 0 publishable → bỏ qua cycle`);
        continue;
      }
      const batch = drafts.slice(0, per);
      const ids = batch.map((d) => d.id);
      await batchPublish(opts.cookieUser, ids as any);
      published += ids.length;
      perShop[shop.shopName] = ids.length;
      remaining += Math.max(0, drafts.length - ids.length);
      const title = String((batch[0] as any)?.title ?? ids[0]).slice(0, 42);
      log(`  ✓ ${shop.shopName}: +${ids.length} (${title}) · còn ${drafts.length - ids.length} draft`);
      await sleep(jitterMs(jit[0], jit[1]));
    } catch (e: any) {
      log(`  ✗ ${shop.shopName}: ${e?.message ?? e}`);
    }
  }
  return { published, perShop, remaining };
}

/* ============= Background scheduler (self-rescheduling, random interval) ============= */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function scheduleDripPublisher(): void {
  const cfg = publishConfig();
  if (!cfg.enabled) {
    console.log("⏰ Drip-publish: TẮT (publish.json → enabled=false)");
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      console.log("[drip] ▶ cycle bắt đầu…");
      const r = await runDripCycle({
        cookieUser: cfg.cookieUser,
        perShopPerCycle: cfg.perShopPerCycle,
        interShopJitterSec: [cfg.interShopJitterMinSec, cfg.interShopJitterMaxSec],
        onLog: (m) => console.log("[drip]", m),
      });
      console.log(`[drip] cycle xong: publish ${r.published}, còn ~${r.remaining} draft`);
      if (r.published === 0 && r.remaining === 0) {
        // Hết draft mọi shop → KHÔNG dừng vĩnh viễn (crawl/list vẫn đổ draft mới về).
        // Re-poll ở interval bình thường để tự nhặt draft mới khi có.
        console.log("[drip] 💤 Hết draft mọi shop — idle, sẽ poll lại cycle kế.");
      }
    } catch (e: any) {
      console.error("[drip] ✗ Lỗi cycle:", e?.message ?? e);
    }
    running = false;
    const ms = randMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
    console.log(`[drip] cycle kế sau ~${Math.round(ms / 60000)} phút`);
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, 5000); // chạy lần đầu sau 5s
  console.log(`⏰ Drip-publish: BẬT (${cfg.intervalMinMinutes}-${cfg.intervalMaxMinutes}p/cycle · ${cfg.perShopPerCycle} draft/shop)`);
}

export function stopDripPublisher(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
