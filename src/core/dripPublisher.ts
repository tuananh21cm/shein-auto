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
import { listAccounts } from "../state/fourSellerAccounts";

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

/**
 * Shop đã đụng TRẦN LISTING (errMsg Listing.Back.Day_Limit) thì retry bao nhiêu lần cũng vô ích:
 * đo 17/09 TN Scan43 (active=101, 37 draft) nhận batchPublish suốt 25 phút mà active đứng im,
 * trong khi TaiAri (95) lên 99 và Urban Noble (97) lên 101. Trần KHÔNG đồng nhất 100
 * (Calmwell 411, MaeBLa 200) nên không hardcode ngưỡng được — thay vào đó nhận diện bằng
 * dấu hiệu thực nghiệm: shop mà MỌI draft đều publish_failed (không có draft mới nào) coi như
 * đã đầy, chỉ thử lại mỗi RETRY_COLD_MS thay vì mỗi cycle 25-35 phút.
 * Có draft mới về → publish ngay, không dính backoff.
 */
const RETRY_COLD_MS = 6 * 3_600_000;
// ponytail: Map in-memory, mất khi restart — chấp nhận, restart hiếm hơn nhiều so với cycle.
const coldShop = new Map<string, number>();

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
      // Nhặt cả "publishable" LẪN "publish_failed": đa số publish_failed là
      // Listing.Back.Day_Limit (hết hạn mức đăng/ngày của shop) — hôm sau đăng lại được.
      // Trước đây bộ lọc chỉ lấy "publishable" nên đám này KHÔNG AI nhặt lại, đọng vĩnh viễn
      // (đo 17/09: 183 draft kẹt trên 2 tài khoản, 0 cái drip lấy được).
      // Đã verify batchPublish CHẤP NHẬN chúng: publish_failed → publishing.
      // LOẠI "publishing" (đang publish dở → batch-publish báo "status does not support
      // modification", lấy nhầm sẽ KẸT vĩnh viễn ở draft đầu) và "unpublishable" (thiếu dữ
      // liệu, đăng lại vẫn hỏng nên chỉ quay vòng vô ích).
      const SKIP = new Set(["publishing", "unpublishable", "normal"]);
      const drafts = all.filter((d) => !SKIP.has(String(d.publishStatus ?? "")));
      if (!drafts.length) {
        const busy = all.filter((d) => d.publishStatus === "publishing").length;
        if (busy) log(`  ⏳ ${shop.shopName}: ${busy} draft đang 'publishing' → bỏ qua cycle`);
        continue;
      }
      // Draft MỚI (chưa từng fail) ưu tiên đăng trước hàng tồn.
      const fresh = drafts.filter((d) => d.publishStatus !== "publish_failed");
      if (!fresh.length) {
        const key = `${opts.cookieUser}/${shop.id}`;
        const last = coldShop.get(key) ?? 0;
        const waited = Date.now() - last;
        if (waited < RETRY_COLD_MS) {
          log(`  ❄️ ${shop.shopName}: ${drafts.length} draft toàn publish_failed (nghi đầy trần) → chờ ${Math.round((RETRY_COLD_MS - waited) / 3600_000)}h nữa`);
          continue;
        }
        coldShop.set(key, Date.now());
      }
      const retryN = drafts.filter((d) => d.publishStatus === "publish_failed").length;
      if (retryN) log(`  ↻ ${shop.shopName}: ${retryN}/${drafts.length} draft là publish_failed → đăng lại`);
      const batch = [...fresh, ...drafts.filter((d) => d.publishStatus === "publish_failed")].slice(0, per);
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
      // Duyệt MỌI tài khoản 4Seller, không chỉ cfg.cookieUser: trước đây drip chạy duy nhất
      // 1 principal nên shop của các tài khoản khác không ai publish (đo 17/09: 164/183 draft
      // kẹt nằm ở acct 53770051197 — ngoài tầm với của drip dù bộ lọc đã sửa).
      // cfg.cookieUser chỉ còn là fallback khi chưa có account nào lưu cookie.
      let principals = [cfg.cookieUser];
      try {
        const accs = await listAccounts();
        if (accs.length) principals = accs.map((a) => `acct:${a.uid}`);
      } catch (e: any) {
        console.warn("[drip] ⚠ Không đọc được danh sách account → dùng cfg.cookieUser:", e?.message ?? e);
      }
      const r = { published: 0, remaining: 0 };
      for (const principal of principals) {
        if (principals.length > 1) console.log(`[drip] ── ${principal}`);
        const one = await runDripCycle({
          cookieUser: principal,
          perShopPerCycle: cfg.perShopPerCycle,
          interShopJitterSec: [cfg.interShopJitterMinSec, cfg.interShopJitterMaxSec],
          onLog: (m) => console.log("[drip]", m),
        }).catch((e: any) => {
          console.error(`[drip] ✗ ${principal}: ${e?.message ?? e}`);
          return { published: 0, remaining: 0, perShop: {} };
        });
        r.published += one.published;
        r.remaining += one.remaining;
      }
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
