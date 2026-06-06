import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/**
 * Bóc chỉ số quản lý Sản phẩm (trang /product/manage) — xác minh discovery 2026-06-06.
 * Endpoint product/local/products/list: total_product_count + products[] (trang đầu ~50)
 * mỗi SP có product_performance.last_28days_pv/order, total_available_stock, product_low_stock.
 *
 * total_product_count chính xác toàn shop; các đếm low/out-stock & top-views tính trên TRANG
 * ĐẦU (mặc định ~50 SP gần nhất) — đủ làm tín hiệu hằng ngày.
 */
export function extractProductManage(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const c = caps.find((x) => /product\/local\/products\/list/.test(x.url));
  const d = c ? (c.body?.data ?? c.body) : undefined;
  if (!d) return out;

  const total = toNum(d.total_product_count);
  if (total !== null) out.push({ key: "products_total", valueNum: total, unit: "count" });

  const products = Array.isArray(d.products) ? d.products : [];
  if (!products.length) return out;

  let zeroViews = 0;
  let lowStock = 0;
  let outStock = 0;
  const ranked: { name: string; pv: number; ord: number; stock: number }[] = [];

  for (const p of products) {
    const perf = p.product_performance || {};
    const pv = toNum(perf.last_28days_pv) ?? 0;
    const ord = toNum(perf.last_28days_order) ?? 0;
    if (pv === 0) zeroViews++;
    const ls = p.product_low_stock || {};
    if ((toNum(ls.low_stock_sku_count) ?? 0) > 0) lowStock++;
    if ((toNum(ls.out_of_stock_sku_count) ?? 0) > 0) outStock++;
    ranked.push({
      name: String(p.product_name || "").slice(0, 50),
      pv,
      ord,
      stock: toNum(p.total_available_stock) ?? 0,
    });
  }

  out.push({ key: "products_no_views_28d", valueNum: zeroViews, unit: "count" });
  out.push({ key: "products_low_stock", valueNum: lowStock, unit: "count" });
  out.push({ key: "products_out_of_stock", valueNum: outStock, unit: "count" });

  ranked.sort((a, b) => b.pv - a.pv);
  ranked.slice(0, 5).forEach((x, i) => {
    out.push({
      key: `top_product_${i + 1}`,
      valueText: `${x.name} — ${x.pv} views / ${x.ord} đơn (28d), tồn ${x.stock}`,
    });
  });

  return out;
}
