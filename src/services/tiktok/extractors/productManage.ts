import type { Capture, Metric, ListingViewRow } from "../types";
import { toNum } from "../deepFind";

/** Gộp products[] từ MỌI capture products/list (trang 1 + trang 2 nếu paginate), dedupe. */
function collectProducts(caps: Capture[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const c of caps) {
    if (!/product\/local\/products\/list/.test(c.url)) continue;
    const d = c.body?.data ?? c.body;
    for (const p of Array.isArray(d?.products) ? d.products : []) {
      const k = String(p.product_id ?? p.product_name ?? "");
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/**
 * Bóc chỉ số quản lý Sản phẩm (trang /product/manage) — xác minh discovery 2026-06-06.
 * Endpoint product/local/products/list: total_product_count + products[] (50 SP/trang)
 * mỗi SP có product_performance.last_28days_pv/order, total_available_stock, product_low_stock.
 *
 * total_product_count chính xác toàn shop; đếm low/out-stock & top-views tính trên các trang
 * đã capture (route tự click trang 2 khi shop >50 SP — xem paginateProductManage).
 */
export function extractProductManage(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const c = caps.find((x) => /product\/local\/products\/list/.test(x.url));
  const d = c ? (c.body?.data ?? c.body) : undefined;
  if (!d) return out;

  const total = toNum(d.total_product_count);
  if (total !== null) out.push({ key: "products_total", valueNum: total, unit: "count" });

  const products = collectProducts(caps);
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

/**
 * Bóc snapshot PER-LISTING (view/đơn/GMV 28d + tồn) từ products/list — mọi capture của
 * endpoint (nhiều trang nếu có), dedupe theo product_id. pv/order là CỬA SỔ TRƯỢT 28 ngày:
 * diff giữa 2 ngày = view mới hôm qua − view rớt khỏi cửa sổ (ngày 29) → xấp xỉ đà tăng/giảm.
 */
export function extractListingRows(caps: Capture[]): ListingViewRow[] {
  const rows: ListingViewRow[] = [];
  for (const p of collectProducts(caps)) {
    const id = String(p.product_id ?? "").trim();
    if (!id) continue; // listing_views PK cần product_id
    const perf = p.product_performance || {};
    // last_28days_gmv dạng "$1,234.56" → số
    const gmvRaw = String(perf.last_28days_gmv ?? "").replace(/[^0-9.]/g, "");
    rows.push({
      productId: id,
      productName: String(p.product_name || "").slice(0, 120),
      pv28d: toNum(perf.last_28days_pv) ?? 0,
      orders28d: toNum(perf.last_28days_order) ?? 0,
      gmv28d: gmvRaw ? Number(gmvRaw) : null,
      salesTotal: toNum(p.product_sales?.total_sales),
      stock: toNum(p.total_available_stock),
    });
  }
  return rows;
}
