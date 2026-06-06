import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/** Slug gọn từ title_text của cột dashboard (Action Needed / return stats). */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/24 hours( or less)?/g, "24h")
    .replace(/\(last 7d\)/g, "7d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}

/**
 * Bóc các cột `dashboard_columns` (mỗi cột {title_text, order_count}) — dùng chung cho
 * order dashboard (/fulfillment/na/dashboard/get) và return dashboard (/reverse/dashboard/get).
 * Key = `${prefix}${slug(title)}` → tự bắt cột mới khi TikTok thêm.
 */
export function extractDashboard(caps: Capture[], urlRe: RegExp, prefix: string): Metric[] {
  const out: Metric[] = [];
  const c = caps.find((x) => urlRe.test(x.url));
  const d = c ? (c.body?.data ?? c.body) : undefined;
  if (Array.isArray(d?.dashboard_columns)) {
    for (const col of d.dashboard_columns) {
      const n = toNum(col.order_count);
      if (n === null || !col.title_text) continue;
      out.push({ key: `${prefix}${slug(col.title_text)}`, valueNum: n, unit: "count" });
    }
  }
  return out;
}
