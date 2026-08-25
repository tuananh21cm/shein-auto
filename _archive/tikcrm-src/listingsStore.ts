/**
 * Store listing + view của shop (mirror type "shop_listings" từ extension).
 * Giữ snapshot MỚI NHẤT + snapshot TRƯỚC ĐÓ theo shop → tính được Δ view/đơn giữa
 * 2 lần cào (mỗi lần ~1 ngày) mà không phình file. Ngoài ra append 1 dòng tổng/ngày
 * vào history.jsonl để xem đà shop-level.
 */
import fs from "fs-extra";
import path from "path";

const ROOT = path.resolve(process.cwd(), "data", "tikcrm", "listings");
const safeCode = (s: any) => String(s || "unknown").replace(/[^\w.-]/g, "_").slice(0, 120);

export interface ListingItem {
  product_id: string; product_name: string;
  pv_28d: number; orders_28d: number; gmv_28d: string;
  stock: number; low_stock_sku: number; out_of_stock_sku: number; sales_total: number;
}
export interface ListingsSnapshot {
  received_at: string; shop_id?: any; shop_code?: any; shop_name?: any;
  region?: any; total_product_count?: number; listings: ListingItem[];
}

/** Lưu snapshot mới; xoay latest → prev để giữ mốc so sánh. Trả về code shop. */
export function saveListings(body: { payload?: any }): string {
  const p = body?.payload ?? {};
  const code = safeCode(p.shop_code || p.shop_id);
  const dir = path.join(ROOT, code);
  fs.ensureDirSync(dir);
  const latestFile = path.join(dir, "latest.json");
  const prevFile = path.join(dir, "prev.json");

  const snap: ListingsSnapshot = {
    received_at: new Date().toISOString(),
    shop_id: p.shop_id, shop_code: p.shop_code, shop_name: p.shop_name,
    region: p.region, total_product_count: Number(p.total_product_count) || 0,
    listings: Array.isArray(p.listings) ? p.listings : [],
  };

  // latest hiện tại → prev (mốc so sánh), rồi ghi latest mới
  if (fs.existsSync(latestFile)) {
    try { fs.copySync(latestFile, prevFile, { overwrite: true }); } catch { /* bỏ qua */ }
  }
  fs.writeFileSync(latestFile, JSON.stringify(snap));
  // history tổng (nhẹ)
  fs.appendFileSync(
    path.join(ROOT, "history.jsonl"),
    JSON.stringify({ at: snap.received_at, code, total: snap.total_product_count,
      pv: snap.listings.reduce((a, x) => a + (x.pv_28d || 0), 0),
      orders: snap.listings.reduce((a, x) => a + (x.orders_28d || 0), 0) }) + "\n"
  );
  return code;
}

/** Latest + Δ (pv/orders) so với prev, join theo product_id. Sort pv giảm dần. */
export function getListings(code: string): {
  received_at?: string; prev_at?: string; total_product_count?: number;
  listings: (ListingItem & { d_pv?: number | null; d_orders?: number | null })[];
} {
  const dir = path.join(ROOT, safeCode(code));
  const latestFile = path.join(dir, "latest.json");
  if (!fs.existsSync(latestFile)) return { listings: [] };
  const latest: ListingsSnapshot = fs.readJsonSync(latestFile);
  let prev: ListingsSnapshot | null = null;
  try { prev = fs.readJsonSync(path.join(dir, "prev.json")); } catch { /* chưa có prev */ }
  const prevById = new Map<string, ListingItem>();
  (prev?.listings ?? []).forEach((x) => prevById.set(x.product_id, x));

  const rows = (latest.listings ?? []).map((x) => {
    const pp = prevById.get(x.product_id);
    return {
      ...x,
      d_pv: pp ? (x.pv_28d || 0) - (pp.pv_28d || 0) : null,
      d_orders: pp ? (x.orders_28d || 0) - (pp.orders_28d || 0) : null,
    };
  });
  rows.sort((a, b) => (b.pv_28d || 0) - (a.pv_28d || 0));
  return { received_at: latest.received_at, prev_at: prev?.received_at, total_product_count: latest.total_product_count, listings: rows };
}
