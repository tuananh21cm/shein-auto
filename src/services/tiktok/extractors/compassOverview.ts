import type { Capture, Metric } from "../types";
import { deepFindFirst, toNum } from "../deepFind";

/**
 * Bóc chỉ số Compass overview (GMV, đơn, traffic, conversion).
 * Key ứng viên — tinh chỉnh sau discovery.
 */
export function extractCompassOverview(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const bodies = caps.map((c) => c.body);

  const push = (key: string, candidates: string[], unit?: string) => {
    for (const b of bodies) {
      const raw = deepFindFirst(b, candidates);
      const n = toNum(raw);
      if (n !== null) { out.push({ key, valueNum: n, unit: unit ?? null }); return; }
    }
  };

  push("gmv", ["gmv", "GMV", "total_gmv", "gmv_amount", "revenue"], "USD");
  push("orders", ["order_cnt", "orderCount", "orders", "order_count", "paid_order_cnt"], "count");
  push("visitors", ["visitor_cnt", "visitors", "uv", "visitor_count"], "count");
  push("page_views", ["pv", "page_view", "views", "product_views"], "count");
  push("conversion_rate", ["conversion_rate", "conversionRate", "cvr", "cr"], "%");
  push("refund_rate", ["refund_rate", "refundRate", "return_rate"], "%");

  return out;
}
