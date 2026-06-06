import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

function find(caps: Capture[], re: RegExp): any | undefined {
  const c = caps.find((x) => re.test(x.url));
  if (!c) return undefined;
  return c.body?.data ?? c.body;
}

/** Slug gọn từ title_text của cột Action Needed. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/24 hours or less/g, "24h")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}

/**
 * Bóc chỉ số quản lý Order (trang /order) — xác minh discovery 2026-06-06.
 * - dashboard/get → "Action needed": ship_24h, auto_cancel, overdue, cancellation,
 *   logistics_issue, return_refund (mỗi cột title_text + order_count). Đây là việc CẦN LÀM.
 * - search_count.count_map → đếm theo trạng thái: 101=To ship, 1100=Shipped (xác minh từ UI).
 */
export function extractOrders(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  const dash = find(caps, /fulfillment\/na\/dashboard\/get/);
  if (dash && Array.isArray(dash.dashboard_columns)) {
    for (const col of dash.dashboard_columns) {
      const n = toNum(col.order_count);
      if (n === null || !col.title_text) continue;
      out.push({ key: `action_${slug(col.title_text)}`, valueNum: n, unit: "count" });
    }
  }

  const sc = find(caps, /order\/search_count/);
  if (sc?.count_map) {
    const m = sc.count_map;
    const toShip = toNum(m["101"]);
    const shipped = toNum(m["1100"]);
    if (toShip !== null) out.push({ key: "orders_to_ship", valueNum: toShip, unit: "count" });
    if (shipped !== null) out.push({ key: "orders_shipped", valueNum: shipped, unit: "count" });
  }

  return out;
}
