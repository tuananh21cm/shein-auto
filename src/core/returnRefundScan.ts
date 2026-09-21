/**
 * returnRefundScan — kéo case Return/Refund TikTok từ 4Seller (Order → After sales manage),
 * để admin thấy case nào SẮP HẾT HẠN xử lý mà chưa ai đụng tới.
 *
 * Hạn xử lý (`deadlineTime`) chỉ có khi case đang chờ SELLER — thực tế đo được: case đã
 * được khách gửi hàng hoàn (BUYER_SHIPPED_ITEM) chờ bạn xác nhận nhận hàng. Case đã xong
 * hay đã huỷ thì hạn để trống, không tính.
 *
 * Mốc giờ API trả về theo MÚI GIỜ TÀI KHOẢN 4Seller (vd America/Los_Angeles), không phải
 * UTC hay giờ máy → đọc múi giờ từ user-info mỗi lần quét rồi đổi sang epoch.
 *
 * CHỈ ĐỌC. Không lưu tên / địa chỉ người mua.
 */
import path from "path";
import fs from "fs-extra";
import {
  getReturnPage,
  getReturnStatusCount,
  getShopList,
  getUserZone,
  type ReturnCase,
  type ReturnStatusCount,
} from "../services/fourseller/client";
import { listAccounts } from "../state/fourSellerAccounts";

/** Quét MỌI tài khoản 4Seller đã nạp cookie. Muốn bỏ tài khoản nào thì thêm uid vào đây. */
const SKIP_UIDS: string[] = [];

/** Trạng thái đã khép lại — không còn việc cho seller. */
const CLOSED_STATUS = new Set(["completed"]);

export interface ReturnRow {
  returnId: string;
  orderId: string;
  account: string;
  shop: string;
  type: string;
  status: string;
  statusText: string;
  reason: string;
  amount: number;
  currency: string;
  createdAt: number | null;
  deadlineAt: number | null;
  returnTracking: string;
  items: { name: string; sku: string; variant: string; qty: number; image: string }[];
}

export interface ReturnScanResult {
  scannedAt: number;
  accounts: { label: string; uid: string; zone: string | null; counts: ReturnStatusCount | null; fetched: number }[];
  /** Case còn mở (chưa completed) — kèm case có hạn. */
  rows: ReturnRow[];
  errors: string[];
}

/** Offset (ms) của múi giờ tại 1 thời điểm UTC — dùng Intl, tự tính giờ mùa hè. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

/** "YYYY-MM-DD HH:mm:ss" theo múi `zone` → epoch ms. zone null → coi là UTC. */
export function zonedToEpoch(s: string | null | undefined, zone: string | null): number | null {
  const m = (s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!zone) return naive;
  // 2 vòng để đúng cả quanh lúc đổi giờ mùa hè
  let t = naive - zoneOffsetMs(zone, naive);
  t = naive - zoneOffsetMs(zone, t);
  return t;
}

async function fetchAllCases(principal: string, max = 3000): Promise<ReturnCase[]> {
  const out: ReturnCase[] = [];
  for (let p = 1; p <= Math.ceil(max / 100); p++) {
    const d = await getReturnPage(principal, { pageCurrent: p, pageSize: 100 });
    const recs = d?.records ?? [];
    out.push(...recs);
    if (!recs.length || out.length >= (d?.total ?? 0)) break;
  }
  return out;
}

export async function scanReturns(opts?: { onLog?: (m: string) => void }): Promise<ReturnScanResult> {
  const log = opts?.onLog ?? ((m: string) => console.log(`[returns] ${m}`));
  const all = await listAccounts();
  const accounts = all.filter((a) => !SKIP_UIDS.includes(a.uid));
  const result: ReturnScanResult = { scannedAt: Date.now(), accounts: [], rows: [], errors: [] };
  if (!accounts.length) result.errors.push("Chưa có tài khoản 4Seller nào — nạp cookie ở tab Cookie 4Seller.");

  // Các tài khoản độc lập → quét song song; lỗi 1 tài khoản không chặn tài khoản khác.
  await Promise.all(accounts.map(async (acc) => {
    const principal = `acct:${acc.uid}`;
    try {
      const [zone, counts, shops, cases] = await Promise.all([
        getUserZone(principal).catch(() => null),
        getReturnStatusCount(principal).catch(() => null),
        getShopList(principal).catch(() => ({ records: [] as any[] })),
        fetchAllCases(principal),
      ]);
      const shopName = new Map<number, string>((shops?.records ?? []).map((s: any) => [Number(s.id), s.shopName]));
      let open = 0;
      for (const c of cases) {
        if (CLOSED_STATUS.has(c.status) && !c.deadlineTime) continue;
        open++;
        result.rows.push({
          returnId: c.returnId,
          orderId: c.platformOrderId,
          account: acc.label,
          shop: shopName.get(Number(c.shopId)) ?? `shop#${c.shopId}`,
          type: c.returnType,
          status: c.status,
          statusText: c.returnStatus || c.platformReturnStatus,
          reason: c.returnReason,
          amount: Number(c.refundTotal) || 0,
          currency: c.currency || "USD",
          createdAt: zonedToEpoch(c.platformCreateTime, zone),
          deadlineAt: zonedToEpoch(c.deadlineTime, zone),
          returnTracking: c.returnTrackingNumber || "",
          items: (c.productList ?? []).map((p) => ({
            name: p.productName, sku: p.sellerSku, variant: p.skuName, qty: p.quantity, image: p.imageUrl,
          })),
        });
      }
      result.accounts.push({ label: acc.label, uid: acc.uid, zone, counts, fetched: cases.length });
      log(`${acc.label}: ${cases.length} case, ${open} còn mở, múi giờ ${zone ?? "?"}`);
    } catch (e: any) {
      const msg = `${acc.label}: ${e?.message ?? e}`;
      result.errors.push(msg);
      log(`✗ ${msg}`);
    }
  }));
  result.accounts.sort((a, b) => a.label.localeCompare(b.label));

  // Có hạn trước (gần nhất lên đầu), rồi tới case không hạn mới nhất.
  result.rows.sort((a, b) =>
    (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return result;
}

/* ============= Store (memory + disk) ============= */

const SCAN_FILE = path.resolve(process.cwd(), "data", "_return_refund_scan.json");
let lastResult: ReturnScanResult | null = null;
let scanRunning = false;

export const isReturnScanRunning = (): boolean => scanRunning;

export async function getLastReturnScan(): Promise<ReturnScanResult | null> {
  if (lastResult) return lastResult;
  try { lastResult = await fs.readJson(SCAN_FILE); } catch { /* chưa có */ }
  return lastResult;
}

export async function runAndStoreReturnScan(opts?: { onLog?: (m: string) => void }): Promise<ReturnScanResult> {
  if (scanRunning) throw new Error("Đang quét return/refund — chờ xong đã");
  scanRunning = true;
  try {
    const r = await scanReturns(opts);
    lastResult = r;
    await fs.writeJson(SCAN_FILE, r, { spaces: 1 }).catch(() => {});
    return r;
  } finally {
    scanRunning = false;
  }
}
