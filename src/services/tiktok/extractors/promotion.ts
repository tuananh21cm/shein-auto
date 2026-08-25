import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/** Tìm capture đầu tiên có url khớp, trả phần data (body.data ?? body). */
function find(caps: Capture[], re: RegExp): any | undefined {
  const c = caps.find((x) => re.test(x.url));
  if (!c) return undefined;
  return c.body?.data ?? c.body;
}

/**
 * Bóc chỉ số Promotion (trang /promotion/marketing-tools/tool-choose) — xác minh
 * discovery 2026-06-06. Capture-first (route có thể dính captcha).
 *
 * - get_summary: số promotion theo trạng thái (2=đang chạy, 3=sắp diễn ra).
 * - promotion/info v4: số công cụ promotion đang bật.
 * - period/stats: doanh thu promotion 7 ngày. LƯU Ý: revenue các tool TRÙNG nhau
 *   (1 đơn tính cho nhiều tool) → lấy tool cao nhất, KHÔNG cộng (tránh overcount).
 */
export function extractPromotion(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  // 1. Số promotion theo trạng thái
  const sum = find(caps, /\/promotion\/get_summary/);
  if (sum && Array.isArray(sum.quantity_info)) {
    const qtyOf = (st: number) => sum.quantity_info.find((q: any) => q.promotion_status === st)?.quantity;
    const ongoing = toNum(qtyOf(2));
    const upcoming = toNum(qtyOf(3));
    if (ongoing !== null) out.push({ key: "promotions_ongoing", valueNum: ongoing, unit: "count" });
    if (upcoming !== null) out.push({ key: "promotions_upcoming", valueNum: upcoming, unit: "count" });
  }

  // 2. Số công cụ promotion đang bật
  const info = find(caps, /v4\/insights\/seller\/shop\/promotion\/info/);
  if (info && Array.isArray(info.promotions)) {
    const enabled = info.promotions.filter((p: any) => p?.info?.has_any_promotion_tool).length;
    out.push({ key: "promotion_tools_enabled", valueNum: enabled, unit: "count" });
  }

  // 3. Doanh thu promotion 7 ngày (tool cao nhất — tránh trùng khi cộng)
  const ps = find(caps, /promotion\/period\/stats/);
  if (ps && Array.isArray(ps.segments)) {
    let topRev = 0;
    let found = false;
    for (const seg of ps.segments) {
      for (const t of seg.timed_stats || []) {
        for (const pt of t.stats_promotion_tools || []) {
          for (const m of pt.metrics || []) {
            if (/revenue/i.test(m.stats_type_str || "")) {
              const v = toNum(m.stats);
              if (v !== null) {
                found = true;
                if (v > topRev) topRev = v;
              }
            }
          }
        }
      }
    }
    if (found) out.push({ key: "promotion_revenue_top_7d", valueNum: topRev, unit: "USD" });
  }

  return out;
}
