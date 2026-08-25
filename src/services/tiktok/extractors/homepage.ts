import type { Capture, Metric } from "../types";
import { deepFind, toNum } from "../deepFind";

/** Tìm capture đầu tiên có url khớp, trả về phần data (body.data ?? body). */
function find(caps: Capture[], re: RegExp): any | undefined {
  const c = caps.find((x) => re.test(x.url));
  if (!c) return undefined;
  return c.body?.data ?? c.body;
}

/**
 * Bóc chỉ số trang /homepage — target ĐÚNG endpoint (xác minh từ discovery 2026-06-05).
 * Tập trung "sức khỏe shop": AHR score, vi phạm, settlement, đơn.
 */
export function extractHomepage(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  // 1. AHR score (Account Health Rating) — /account/ahr/score → { score }
  const ahr = find(caps, /\/account\/ahr\/score/);
  if (ahr) {
    const s = toNum(deepFind(ahr, "score"));
    if (s !== null) out.push({ key: "ahr_score", valueNum: s, unit: "score" });
  }

  // 2. Vi phạm — /violation/overview/get
  const vio = find(caps, /violation\/overview\/get/);
  if (vio) {
    const vs = toNum(vio.violation_score);
    if (vs !== null) out.push({ key: "violation_score", valueNum: vs, unit: "score" });

    const pts = vio.violation_points_v2;
    if (Array.isArray(pts)) {
      const total = pts.reduce((a: number, p: any) => a + (toNum(p.count) ?? 0), 0);
      out.push({ key: "violation_total", valueNum: total, unit: "count" });
      const critical = pts.find((p: any) => /risk_fraud/.test(p.violation_type_key || ""));
      if (critical) out.push({ key: "violation_critical", valueNum: toNum(critical.count) ?? 0, unit: "count" });
      const fulfill = pts.find((p: any) => /order_fulfillment/.test(p.violation_type_key || ""));
      if (fulfill) out.push({ key: "violation_fulfillment", valueNum: toNum(fulfill.count) ?? 0, unit: "count" });
    }
    if (typeof vio.has_new_violation === "boolean")
      out.push({ key: "has_new_violation", valueText: String(vio.has_new_violation) });
  }

  // 3. Tiền chờ settle — /pay/statement/stat/info → to_settle_amount_stat.amount.amount
  const pay = find(caps, /pay\/statement\/stat\/info/);
  if (pay) {
    const settle = toNum(pay?.to_settle_amount_stat?.amount?.amount);
    if (settle !== null) out.push({ key: "to_settle_amount", valueNum: settle, unit: "USD" });
  }

  // 4. Tổng đơn (widget order/list) — total_count
  const ord = find(caps, /fulfillment\/na\/order\/list/);
  if (ord) {
    const tc = toNum(ord.total_count);
    if (tc !== null) out.push({ key: "orders_total", valueNum: tc, unit: "count" });
  }

  return out;
}
