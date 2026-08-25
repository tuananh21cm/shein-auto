/**
 * promotionScan — cào trạng thái PROMOTION (Product Discount + Flash Deal) của mọi shop
 * qua 4Seller Marketing API, trên MỌI tài khoản 4Seller đã upload.
 *
 * Luồng mỗi lần scan (đúng thao tác tay trên UI 4Seller):
 *   1. Trigger "Sync promotion" (sync-tiktok-activity, All Shop) → 4Seller kéo data mới từ TikTok.
 *   2. Poll get-sync-schedule đến khi false (sync xong) — timeout thì vẫn đọc (data cũ hơn vài phút).
 *   3. Đọc toàn bộ activity (get-page, phân trang) + số listing ACTIVE từng shop (get-status-count).
 *   4. Tổng hợp per shop:
 *      - discount ONGOING: tổng productCount đang chạy → uncovered = active - covered (sp CHƯA chạy discount)
 *      - flash: đang chạy / sắp chạy / HẾT HẠN (không còn flash ONGOING/NOT_START)
 *      - cảnh báo: flash hết hạn, flash sắp hết (<24h) mà chưa có kế tiếp, shop chưa có discount, uncovered > 0
 */
import path from "path";
import fs from "fs-extra";
import cron from "node-cron";
import {
  getPromotionPage,
  syncTiktokPromotions,
  getPromotionSyncSchedule,
  getShopList,
  getStatusCount,
  type PromotionActivity,
} from "../services/fourseller/client";
import { listAccounts } from "../state/fourSellerAccounts";

export interface ShopPromotionRow {
  shop: string;
  shopId: number;
  account: string; // label tài khoản 4Seller
  activeListings: number | null; // null = không lấy được
  // Product Discount
  discountOngoing: number;        // số activity DIRECT_DISCOUNT đang chạy
  discountProductsCovered: number; // tổng productCount của các discount đang chạy
  uncoveredProducts: number | null; // active - covered (null nếu không có active count)
  nextDiscountEnd: number | null;  // endTime gần nhất của discount đang chạy
  // Flash Deal
  flashOngoing: number;
  flashUpcoming: number;
  lastFlashEnd: number | null;    // endTime muộn nhất trong các flash còn hiệu lực (ongoing/upcoming)
  flashExpired: boolean;          // không còn flash ongoing/upcoming nào
  alerts: string[];
}

export interface PromotionScanResult {
  scannedAt: number;
  synced: boolean;          // sync trigger + chờ xong thành công
  accounts: number;
  totalActivities: number;
  rows: ShopPromotionRow[];
  errors: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chờ sync xong: poll get-sync-schedule đến khi false. Trả true nếu xong trong timeout. */
async function waitSyncDone(principal: string, timeoutMs: number, log: (m: string) => void): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    try {
      const running = await getPromotionSyncSchedule(principal);
      if (!running) return true;
      log(`   ⏳ sync đang chạy… (${Math.round((Date.now() - start) / 1000)}s)`);
    } catch {
      /* poll lỗi 1 nhịp → thử tiếp */
    }
  }
  return false;
}

/**
 * Đọc TOÀN BỘ activity của 1 tài khoản. CHÚ Ý: get-page với discountType=""
 * CHỈ trả Product Discount (không gộp flash) → phải gọi RIÊNG 2 loại.
 * Phân trang pageSize 100, cap 30 trang/loại.
 */
async function fetchAllActivities(principal: string, log: (m: string) => void): Promise<PromotionActivity[]> {
  const out: PromotionActivity[] = [];
  for (const discountType of ["DIRECT_DISCOUNT", "FLASHSALE"] as const) {
    let got = 0;
    for (let page = 1; page <= 30; page++) {
      const res = await getPromotionPage(principal, { pageCurrent: page, pageSize: 100, discountType });
      const records = res?.records ?? [];
      out.push(...records);
      got += records.length;
      const total = Number(res?.total ?? 0);
      if (records.length < 100 || (total > 0 && got >= total)) break;
    }
    log(`   ✓ ${discountType}: ${got} activity`);
  }
  return out;
}

export async function scanPromotions(opts?: {
  /** Trigger sync trước khi đọc (mặc định true — đúng yêu cầu "mỗi lần cào phải Sync"). */
  sync?: boolean;
  syncTimeoutMs?: number;
  onLog?: (m: string) => void;
}): Promise<PromotionScanResult> {
  const log = opts?.onLog ?? (() => {});
  const doSync = opts?.sync !== false;
  const syncTimeout = opts?.syncTimeoutMs ?? 120_000;
  const now = Date.now();

  const accounts = await listAccounts();
  if (accounts.length === 0) {
    throw new Error("Chưa có tài khoản 4Seller nào (tab Cookie 4Seller) — không scan được promotion.");
  }

  const errors: string[] = [];
  const rowByShop = new Map<string, ShopPromotionRow>();
  let totalActivities = 0;
  let syncedAll = true;

  for (const acc of accounts) {
    const principal = `acct:${acc.uid}`;
    try {
      // 1+2. Sync mới nhất từ TikTok (như bấm nút Sync promotion → All Shop → Sync)
      if (doSync) {
        log(`🔄 [${acc.label}] trigger Sync promotion (All Shop)…`);
        try {
          await syncTiktokPromotions(principal, "");
          const done = await waitSyncDone(principal, syncTimeout, log);
          if (!done) { syncedAll = false; log(`   ⚠️ sync quá ${syncTimeout / 1000}s — đọc data hiện có`); }
          else log(`   ✓ sync xong`);
        } catch (e: any) {
          syncedAll = false;
          log(`   ⚠️ sync lỗi (${e?.message}) — đọc data hiện có`);
        }
      }

      // 3a. Toàn bộ activity
      const activities = await fetchAllActivities(principal, log);
      totalActivities += activities.length;

      // 3b. Số listing ACTIVE từng shop (để tính uncovered)
      const shopList = await getShopList(principal);
      const shops = (shopList?.records ?? []).filter(
        (s) => !s.platform || /tiktok/i.test(String(s.platform))
      );
      const activeByShopId = new Map<number, number | null>();
      await Promise.all(
        shops.map(async (s) => {
          try {
            const sc = await getStatusCount(principal, { shopId: s.id });
            activeByShopId.set(Number(s.id), sc?.activeCount ?? null);
          } catch {
            activeByShopId.set(Number(s.id), null);
          }
        })
      );

      // 4. Aggregate per shop
      for (const s of shops) {
        const shopActs = activities.filter((a) => Number(a.shopId) === Number(s.id));
        const discounts = shopActs.filter((a) => a.discountType === "DIRECT_DISCOUNT");
        const flashes = shopActs.filter((a) => a.discountType === "FLASHSALE");

        const dOngoing = discounts.filter((a) => a.promotionStatus === "ONGOING");
        const fOngoing = flashes.filter((a) => a.promotionStatus === "ONGOING");
        const fUpcoming = flashes.filter((a) => a.promotionStatus === "NOT_START");

        const covered = dOngoing.reduce((sum, a) => sum + (a.productCount || 0), 0);
        const active = activeByShopId.get(Number(s.id)) ?? null;
        const uncovered = active != null ? Math.max(0, active - covered) : null;
        const aliveFlash = [...fOngoing, ...fUpcoming];
        // Max endTime của MỌI flash: shop còn flash → thời điểm flash cuối kết thúc;
        // shop hết flash → biết "hết từ lúc nào" (flash gần nhất đã kết thúc khi nào).
        const lastFlashEnd = flashes.length ? Math.max(...flashes.map((a) => a.endTime || 0)) : null;
        const nextDiscountEnd = dOngoing.length ? Math.min(...dOngoing.map((a) => a.endTime || Infinity)) : null;

        const alerts: string[] = [];
        if (aliveFlash.length === 0) alerts.push("Flash HẾT HẠN — không còn flash đang/sắp chạy");
        else if (lastFlashEnd && lastFlashEnd - now < 24 * 3600e3) alerts.push("Flash cuối sắp hết (<24h) — chưa có flash kế tiếp");
        if (dOngoing.length === 0) alerts.push("Chưa có Product Discount đang chạy");
        else if (uncovered != null && uncovered > 0) alerts.push(`${uncovered} sp CHƯA chạy discount (active ${active}, covered ${covered})`);
        if (nextDiscountEnd && nextDiscountEnd - now < 48 * 3600e3) alerts.push("Discount sắp hết hạn (<48h)");

        rowByShop.set(s.shopName, {
          shop: s.shopName,
          shopId: Number(s.id),
          account: acc.label,
          activeListings: active,
          discountOngoing: dOngoing.length,
          discountProductsCovered: covered,
          uncoveredProducts: uncovered,
          nextDiscountEnd,
          flashOngoing: fOngoing.length,
          flashUpcoming: fUpcoming.length,
          lastFlashEnd,
          flashExpired: aliveFlash.length === 0,
          alerts,
        });
      }
    } catch (e: any) {
      const msg = `[${acc.label}] ${e?.message ?? e}`;
      errors.push(msg);
      log(`   ✗ ${msg}`);
    }
  }

  // Shop có cảnh báo lên đầu, trong đó flash hết hạn ưu tiên nhất
  const rows = [...rowByShop.values()].sort(
    (a, b) => (b.flashExpired ? 1 : 0) - (a.flashExpired ? 1 : 0) || b.alerts.length - a.alerts.length
  );

  return { scannedAt: now, synced: syncedAll, accounts: accounts.length, totalActivities, rows, errors };
}

/* ============= Store (memory + disk) + cron hằng ngày ============= */

const PROMO_SCAN_FILE = path.resolve(process.cwd(), "data", "_promo_scan.json");
let lastResult: PromotionScanResult | null = null;
let scanRunning = false;

export const isPromoScanRunning = (): boolean => scanRunning;

/** Kết quả scan gần nhất — memory trước, fallback đọc file (sống qua restart). */
export async function getLastPromoScan(): Promise<PromotionScanResult | null> {
  if (lastResult) return lastResult;
  try {
    lastResult = await fs.readJson(PROMO_SCAN_FILE);
  } catch {
    /* chưa có */
  }
  return lastResult;
}

/** Chạy scan (sync + cào) rồi lưu memory + disk. Throw nếu đang có scan chạy. */
export async function runAndStorePromoScan(opts?: {
  sync?: boolean;
  onLog?: (m: string) => void;
}): Promise<PromotionScanResult> {
  if (scanRunning) throw new Error("Đang scan promotion — chờ xong đã");
  scanRunning = true;
  try {
    const r = await scanPromotions(opts);
    lastResult = r;
    await fs.writeJson(PROMO_SCAN_FILE, r, { spaces: 1 }).catch(() => {});
    return r;
  } finally {
    scanRunning = false;
  }
}

/**
 * Cron: tự Sync + cào promotion MỖI 2 GIỜ (0,2,4…22h) → dashboard flash/discount luôn tươi,
 * bắt kịp flash hết hạn / sp rớt discount trong ngày, khỏi bấm tay.
 */
export function schedulePromotionCron(): void {
  cron.schedule("0 */2 * * *", async () => {
    try {
      console.log("[promo-cron] ▶ scan mỗi 2 giờ…");
      const r = await runAndStorePromoScan({ sync: true, onLog: (m) => console.log("[promo-cron]", m) });
      const expired = r.rows.filter((x) => x.flashExpired).length;
      const uncovered = r.rows.reduce((s, x) => s + (x.uncoveredProducts ?? 0), 0);
      console.log(`[promo-cron] ✓ ${r.rows.length} shop · ${expired} hết flash · ${uncovered} sp chưa discount`);
    } catch (e: any) {
      console.warn("[promo-cron] ✗", e?.message ?? e);
    }
  });
  console.log("⏰ Promotion cron: 0 */2 * * * (mỗi 2 giờ · sync + cào Marketing 4Seller)");
}
