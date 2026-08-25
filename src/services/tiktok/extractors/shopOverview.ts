import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/**
 * Bóc sales/traffic/conversion từ endpoint shop overview
 * `/api/v3/insights/seller/shop/overview/performance/stats` (xác minh discovery
 * 2026-06-05). Endpoint fire trên các trang /compass/* (product-analysis,
 * customer-analysis, reviews...). Lấy KỲ THEO NGÀY mới nhất (granularity 1D).
 */
function latestDailyStats(caps: Capture[]): { start?: string; end?: string; stats: any } | undefined {
  const c = caps.find((x) => /v3\/insights\/seller\/shop\/overview\/performance\/stats/.test(x.url));
  const d = c ? (c.body?.data ?? c.body) : undefined;
  if (!d || !Array.isArray(d.segments)) return undefined;
  // ưu tiên segment granularity 1D (theo ngày); fallback segment cuối
  const daily = d.segments.find((s: any) => /1d/i.test(s?.time_descriptor?.granularity || ""));
  const seg = daily ?? d.segments[d.segments.length - 1];
  const ts = seg?.timed_stats;
  if (!Array.isArray(ts) || !ts.length) return undefined;
  return ts[ts.length - 1]; // kỳ mới nhất
}

export function extractShopOverview(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const latest = latestDailyStats(caps);
  if (!latest) return out;
  const s = latest.stats || {};

  const push = (key: string, raw: any, unit?: string) => {
    const n = toNum(raw);
    if (n !== null) out.push({ key, valueNum: n, unit: unit ?? null });
  };

  push("revenue", s.revenue, "USD");
  push("gross_revenue", s.gross_revenue, "USD");
  push("refund_amount", s.refund_amount, "USD");
  push("orders", s.main_order_cnt, "count");
  push("items_sold", s.item_sold_cnt, "count");
  push("page_views", s.product_page_view_cnt, "count");
  push("visitors", s.product_page_visitor_cnt, "count");
  push("review_cnt", s.review_cnt, "count");
  push("video_revenue", s.video_content_revenue, "USD");

  const cvr = toNum(s.conversion_rate);
  if (cvr !== null) out.push({ key: "conversion_rate", valueNum: Math.round(cvr * 10000) / 100, unit: "%" });

  if (latest.start) out.push({ key: "period", valueText: `${latest.start}→${latest.end}` });

  return out;
}
