import type { Capture, Metric } from "../types";
import { deepFindFirst, toNum } from "../deepFind";

/**
 * Bóc chỉ số trang /homepage. Danh sách key ứng viên — tinh chỉnh sau discovery.
 */
export function extractHomepage(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const bodies = caps.map((c) => c.body);

  const push = (key: string, candidates: string[], unit?: string) => {
    for (const b of bodies) {
      const raw = deepFindFirst(b, candidates);
      const n = toNum(raw);
      if (n !== null) { out.push({ key, valueNum: n, unit: unit ?? null }); return; }
    }
  };

  push("pending_orders", ["pending_orders", "pendingOrders", "to_be_shipped", "unshipped_cnt"], "count");
  push("alert_count", ["alert_count", "alertCount", "notification_count", "unread_count"], "count");
  push("gmv", ["gmv", "GMV", "total_gmv", "gmv_amount"], "USD");
  push("orders", ["order_cnt", "orderCount", "orders", "order_count"], "count");

  return out;
}
