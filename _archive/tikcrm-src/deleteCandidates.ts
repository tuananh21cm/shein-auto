/**
 * SP NÊN XOÁ — view phải đi đôi với NGÀY LIST.
 *
 * Nguyên tắc (fix "cứ view thấp là xoá"):
 *   - SP mới list (< MIN_AGE ngày) → CHƯA xét xoá, dù view thấp (chưa đủ thời gian có view).
 *   - Chỉ xoá SP đã list đủ lâu MÀ VẪN: view thấp + 0 đơn.
 *   - KHÔNG dùng stock/tồn (bán dropship → tồn ảo). Tín hiệu: view (pv_28d) + đơn (orders_28d).
 *
 * Ngày list lấy từ 4Seller (platformCreateTime) đã snapshot trong kind "fourseller".listing_dates.
 */
import { getListings } from "./listingsStore";
import { getLatestKindSnapshot } from "./dailyStore";

const MIN_AGE_DAYS = 14;   // SP mới hơn 14 ngày → giữ, đang theo dõi
const VIEW_FLOOR = 150;    // pv_28d dưới mức này = "view thấp" (chỉ xét khi đã đủ tuổi)
const UNKNOWN_AGE_VIEW = 30; // không có ngày list → chỉ xoá khi view CỰC thấp (thận trọng)

export interface DeleteCandidate {
  product_id: string; product_name: string; image?: string;
  pv_28d: number; orders_28d: number; age_days: number | null; list_date?: string; reason: string;
}
export interface DeleteResult {
  ok: boolean; items: DeleteCandidate[];
  skipped_new: number;      // số SP bị bỏ qua vì mới list
  has_dates: boolean;       // có dữ liệu ngày list từ 4Seller chưa
  min_age_days: number; view_floor: number;
}

/** "2026-06-26 18:32" → ms (UTC theo ngày, đủ để tính số ngày). */
function parseListDate(s: any): number | null {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

export function computeDeleteCandidates(
  code: string,
  opts: { minAge?: number; viewFloor?: number; now?: number } = {}
): DeleteResult {
  const minAge = opts.minAge ?? MIN_AGE_DAYS;
  const viewFloor = opts.viewFloor ?? VIEW_FLOOR;
  const now = opts.now ?? Date.now();

  const listings = (getListings(code).listings ?? []) as any[];
  const fs = getLatestKindSnapshot(code, "fourseller")?.data;
  const dates: Record<string, string> = (fs && fs.listing_dates) || {};
  const hasDates = Object.keys(dates).length > 0;

  const items: DeleteCandidate[] = [];
  let skippedNew = 0;

  for (const l of listings) {
    const pid = String(l.product_id || "");
    const pv = Number(l.pv_28d) || 0;
    const orders = Number(l.orders_28d) || 0;
    if (orders > 0) continue;        // có đơn → giữ (đang bán được)
    if (pv >= viewFloor) continue;   // view ổn → giữ

    const dms = parseListDate(dates[pid]);
    const age = dms != null ? Math.floor((now - dms) / 86_400_000) : null;

    if (age != null && age < minAge) { skippedNew++; continue; }   // MỚI list → chưa xoá
    if (age == null && pv >= UNKNOWN_AGE_VIEW) continue;            // chưa rõ tuổi → chỉ xoá nếu view cực thấp

    items.push({
      product_id: pid, product_name: l.product_name, image: l.image,
      pv_28d: pv, orders_28d: orders, age_days: age, list_date: dates[pid],
      reason: age != null
        ? `Đã list ${age} ngày · view ${pv} · 0 đơn`
        : `View ${pv} · 0 đơn (chưa có ngày list)`,
    });
  }

  items.sort((a, b) => a.pv_28d - b.pv_28d);
  return { ok: true, items, skipped_new: skippedNew, has_dates: hasDates, min_age_days: minAge, view_floor: viewFloor };
}
