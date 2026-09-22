/**
 * Đẩy "listing registry" sang CRM KBT: goods_id SHEIN ↔ tiktok_product_id ↔ shop.
 * CRM cần bảng này để ghép doanh số / vi phạm theo từng listing về đúng goods_id
 * (POST /agent/listing-registry, upsert theo (goods_id, tiktok_product_id, shop_name)).
 *
 * Port từ nhánh draft (crmSync.pushRegistrySnapshotOnce) với 2 sửa:
 *  - goods_id nằm ở `variationList[].sellerSku` (đường API ghi goods_id vào sellerSku từng
 *    biến thể) — bản cũ không đọc mảng này nên ra 0 dòng. Đo 22/09: moi được 121/121 listing.
 *  - lấy MỌI goods_id của listing (mỗi màu SHEIN là 1 goods_id riêng), không chỉ cái đầu.
 * ponytail: chỉ chạy snapshot hằng ngày (không đẩy ngay sau mỗi lần đăng) — CRM chỉ cần
 * mapping để phân tích, trễ tối đa 1 ngày là đủ. Đẩy theo sự kiện khi thật sự cần realtime.
 */
import { getShopList, getListingPage } from "../services/fourseller/client";
import { listAccounts } from "../state/fourSellerAccounts";
import { crmSettings, crmRequest } from "./opsBoard";

const GID = /^(\d{7,9})(?:[-_].*)?$/; // CRM chỉ nhận goods_id 7–9 chữ số
const BATCH = 500;                     // CRM giới hạn số dòng/request
const MAX_PAGES = 20;                  // 20×100 = 2000 listing/shop

export const goodsIdsOfListing = (rec: any): string[] => {
  const out = new Set<string>();
  const add = (v: unknown) => { const m = String(v ?? "").trim().match(GID); if (m) out.add(m[1]); };
  add(rec?.sellerSku ?? rec?.msku);
  for (const v of rec?.variationList ?? []) add(v?.sellerSku ?? v?.msku);
  return [...out];
};

export interface RegistryResult { shops: number; listings: number; noGid: number; rows: number; accepted: number; skipped: number; errors: string[] }

export async function pushRegistrySnapshot(onLog: (m: string) => void = (m) => console.log("[crm-registry]", m)): Promise<RegistryResult> {
  const res: RegistryResult = { shops: 0, listings: 0, noGid: 0, rows: 0, accepted: 0, skipped: 0, errors: [] };
  if (!crmSettings().enabled) { onLog("CRM chưa cấu hình — bỏ qua"); return res; }
  const nowIso = new Date().toISOString();
  const rows: any[] = [];
  for (const acc of await listAccounts()) {
    const P = `acct:${acc.uid}`;
    let shops: any[] = [];
    try { shops = ((await getShopList(P))?.records ?? []).filter((s: any) => !s.platform || /tiktok/i.test(String(s.platform))); }
    catch (e: any) { res.errors.push(`${acc.label}: ${String(e?.message ?? e).slice(0, 60)}`); continue; }
    for (const shop of shops) {
      res.shops++;
      try {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const d: any = await getListingPage(P, { shopId: shop.id, status: "active", pageCurrent: page, pageSize: 100 });
          const recs: any[] = d?.records ?? [];
          for (const rec of recs) {
            res.listings++;
            const gids = goodsIdsOfListing(rec);
            if (!gids.length) { res.noGid++; continue; }
            for (const gid of gids) rows.push({
              goods_id: gid, tiktok_product_id: String(rec.productId ?? ""), shop_name: shop.shopName, sku: gid,
              title: String(rec.productName ?? rec.title ?? "").slice(0, 400), publish_status: "live", listed_at: nowIso,
            });
          }
          if (recs.length < 100) break;
        }
      } catch (e: any) { res.errors.push(`${shop.shopName}: ${String(e?.message ?? e).slice(0, 60)}`); }
      await new Promise((r) => setTimeout(r, 400)); // giãn nhịp giữa các shop, không dội 4Seller
    }
  }
  res.rows = rows.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const d = await crmRequest<{ accepted?: number; skipped?: number }>("/agent/listing-registry", { source: "shein-auto", rows: rows.slice(i, i + BATCH) });
    res.accepted += d.accepted ?? 0;
    res.skipped += d.skipped ?? 0;
  }
  onLog(`✅ ${res.shops} shop · ${res.listings} listing (${res.noGid} không có goods_id) · ${res.rows} dòng → CRM nhận ${res.accepted}, bỏ ${res.skipped}${res.errors.length ? ` · lỗi: ${res.errors.join("; ")}` : ""}`);
  return res;
}
