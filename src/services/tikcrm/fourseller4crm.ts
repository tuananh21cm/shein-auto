/**
 * Phase 2 — Bơm dữ liệu 4Seller vào kho TikCRM.
 *
 * Map shop 4Seller ↔ shop TikCRM theo tên (normShopName trên platformShopName/shopName),
 * rồi kéo promotion (Flash/Discount + trạng thái + thời gian) ghi vào kho snapshot ngày.
 * Chạy cho mọi shop đã biết (shop_meta) mà khớp được 1 tài khoản 4Seller có cookie.
 */
import { listAccounts, normShopName } from "../../state/fourSellerAccounts";
import { getShopList, getPromotionPage, getListingPage, getActivityInfo, getCategoryById } from "../fourseller/client";
import { listMetaShops, setShopFourSeller, recordDaily, backfillMetaFromShops } from "./dailyStore";

const catNameCache = new Map<string, string>(); // categoryId → tên (ổn định, cache xuyên refresh)

export interface FourSellerRefreshResult {
  accounts: number;
  fourseller_shops: number;
  tikcrm_shops: number;
  matched: number;
  enriched: number;
}

/** Kéo + ghi 4Seller cho toàn bộ shop khớp. onLog để stream tiến độ. */
export async function refreshFourSeller(onLog: (m: string) => void = () => {}): Promise<FourSellerRefreshResult> {
  const backfilled = backfillMetaFromShops();
  if (backfilled) onLog(`Backfill shop_meta: ${backfilled} shop từ store cũ`);
  const accounts = await listAccounts();
  // 1. Bản đồ từ 4Seller: theo sellingPartnerId (= seller_id TikTok, KHỚP CHUẨN) + fallback theo tên
  type FS = { uid: string; shopId: number | string; shopName: string };
  const byPartner = new Map<string, FS>();
  const byName = new Map<string, FS>();
  for (const acc of accounts) {
    try {
      const list = await getShopList(`acct:${acc.uid}`);
      for (const s of list?.records ?? []) {
        if (s.platform && !/tiktok/i.test(String(s.platform))) continue;
        const rec: FS = { uid: acc.uid, shopId: s.id, shopName: s.shopName };
        const pid = (s as any).sellingPartnerId;
        if (pid && !byPartner.has(String(pid))) byPartner.set(String(pid), rec);
        for (const nm of [s.platformShopName, s.shopName].filter(Boolean)) {
          const key = normShopName(String(nm));
          if (key && !byName.has(key)) byName.set(key, rec);
        }
      }
    } catch (e: any) {
      onLog(`⚠️ tài khoản ${acc.uid}: lỗi getShopList — ${e?.message ?? e}`);
    }
  }
  onLog(`4Seller: ${byPartner.size} shop có seller_id từ ${accounts.length} tài khoản`);

  // 2. Đối chiếu với shop TikCRM: ưu tiên seller_id, fallback tên
  const shops = listMetaShops();
  let matched = 0, enriched = 0;
  for (const shop of shops) {
    const fs =
      (shop.shop_id ? byPartner.get(String(shop.shop_id)) : undefined) ??
      byName.get(normShopName(String(shop.shop_name || "")));
    if (!fs) continue;
    matched++;
    setShopFourSeller(shop.shop_code, fs.uid, fs.shopId);
    const principal = `acct:${fs.uid}`;
    try {
      const promo = await getPromotionPage(principal, { shopId: fs.shopId, pageSize: 100 });
      const recs = promo?.records ?? [];
      const ongoing = recs.filter((r) => /ONGOING/i.test(String(r.promotionStatus)));
      const flash = ongoing.filter((r) => /FLASH/i.test(String(r.discountType))).length;
      const discount = ongoing.filter((r) => /DIRECT/i.test(String(r.discountType))).length;
      const activities = recs.slice(0, 60).map((r) => ({
        name: r.activityName, type: r.discountType, status: r.promotionStatus,
        begin: r.beginTime, end: r.endTime, products: r.productCount,
      }));
      // SP đang có KM = TẬP HỢP product_id DUY NHẤT trong các promotion đang chạy (chính xác)
      const promotedSet = new Set<string>();
      for (const r of ongoing) {
        try {
          const info: any = await getActivityInfo(principal, (r as any).id);
          for (const pr of (info?.data ?? info)?.products ?? []) {
            const pid = pr?.listingId ?? pr?.productId ?? pr?.id;
            if (pid != null && pid !== "") promotedSet.add(String(pid));
          }
        } catch { /* 1 promo lỗi → bỏ qua */ }
      }
      const promoted_products = promotedSet.size;

      // Listing active 4Seller → đếm theo categoryId + tổng listing + NGÀY LIST (platformCreateTime)
      const catCount = new Map<string, number>();
      const listing_dates: Record<string, string> = {};   // productId → ngày list TikTok (để tính tuổi listing)
      let active_listings = 0;
      for (let page = 1; page <= 15; page++) {
        const lp = await getListingPage(principal, { shopId: Number(fs.shopId), status: "active", pageCurrent: page, pageSize: 100 });
        const recsL = lp?.records ?? [];
        active_listings += recsL.length;
        for (const r of recsL) {
          const cid = String((r as any).categoryId || "").trim();
          if (cid) catCount.set(cid, (catCount.get(cid) || 0) + 1);
          const pid = String((r as any).productId || "").trim();
          const dt = (r as any).platformCreateTime || (r as any).createTime;
          if (pid && dt && !listing_dates[pid]) listing_dates[pid] = String(dt);
        }
        if (recsL.length < 100) break;
      }
      // Resolve tên cho top 6 category (cache xuyên shop)
      const top_categories: { name: string; count: number }[] = [];
      for (const [cid, cnt] of [...catCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        let name = catNameCache.get(cid);
        if (name === undefined) {
          try { const c: any = await getCategoryById(principal, cid, "US", fs.shopId); name = (c?.data ?? c)?.categoryName || cid; }
          catch { name = cid; }
          catNameCache.set(cid, name!);
        }
        top_categories.push({ name: name!, count: cnt });
      }

      recordDaily("fourseller", {
        payload: { shop_code: shop.shop_code, shop_name: shop.shop_name,
          promo_flash: flash, promo_discount: discount, fourseller_shop_id: fs.shopId,
          active_listings, promoted_products, top_categories, activities, listing_dates },
      });
      enriched++;
      onLog(`✓ ${shop.shop_code} (${fs.shopName}): flash ${flash} · discount ${discount} · tổng ${recs.length} promo`);
    } catch (e: any) {
      onLog(`✗ ${shop.shop_code}: lỗi promotion — ${e?.message ?? e}`);
    }
  }
  onLog(`Xong: khớp ${matched} / ${shops.length} shop TikCRM, bơm ${enriched}.`);
  return { accounts: accounts.length, fourseller_shops: byPartner.size, tikcrm_shops: shops.length, matched, enriched };
}
