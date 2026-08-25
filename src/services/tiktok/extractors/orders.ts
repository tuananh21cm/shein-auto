import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";
import { extractDashboard } from "./_dashboard";

/**
 * Bóc chỉ số quản lý Order (trang /order) — xác minh discovery 2026-06-06.
 * - dashboard/get → "Action needed": ship_24h, auto_canceling, shipping_overdue,
 *   cancellation_requested, logistics_issue, return_refund_requested.
 * - search_count.count_map → 101=To ship, 1100=Shipped (xác minh từ UI).
 */
export function extractOrders(caps: Capture[]): Metric[] {
  const out: Metric[] = extractDashboard(caps, /fulfillment\/na\/dashboard\/get/, "action_");

  const c = caps.find((x) => /order\/search_count/.test(x.url));
  const sc = c ? (c.body?.data ?? c.body) : undefined;
  if (sc?.count_map) {
    const toShip = toNum(sc.count_map["101"]);
    const shipped = toNum(sc.count_map["1100"]);
    if (toShip !== null) out.push({ key: "orders_to_ship", valueNum: toShip, unit: "count" });
    if (shipped !== null) out.push({ key: "orders_shipped", valueNum: shipped, unit: "count" });
  }

  return out;
}
