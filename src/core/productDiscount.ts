/**
 * productDiscount — THÊM sp chưa có discount vào Product Discount ĐANG CHẠY của shop (EDIT, không tạo mới).
 *   getPromotionPage(DIRECT_DISCOUNT) → discount ongoing → id
 *   → getActivityInfo(id) [meta + products cũ] + discountEligibleProducts [sp thêm được]
 *   → add-or-update({id, products: cũ (giữ nguyên) + mới (discount=pct%)})
 * Match với promotionScan.uncoveredProducts (đếm sp chưa discount). dryRun=true: build, KHÔNG lưu.
 * Xem docs/4seller-flash-api.md (cùng endpoint add-or-update, khác discountType + field discount).
 */
import { getShopList, getPromotionPage, getActivityInfo, discountEligibleProducts, saveActivity } from "../services/fourseller/client";
import { resolveAccountForShop } from "../state/fourSellerAccounts";

export interface AddDiscountOptions {
  dryRun?: boolean;
  discountPct?: number;   // % off cho sp MỚI (mặc định 21)
  limit?: number;         // trần sp thêm mỗi lần (mặc định không giới hạn)
  onLog?: (m: string) => void;
}

export interface AddDiscountResult {
  shop: string; shopId: number; account: string; dryRun: boolean;
  activityId: number | null; activityName: string;
  existing: number;   // sp đang trong discount
  addable: number;    // sp đủ điều kiện thêm (page-search)
  added: number;      // sp thực thêm (payload)
  skuAdded: number;
  sample: { productId: string; name: string; skus: number; discount: string }[];
  payload?: any;
  updated?: boolean;
  note?: string;
}

export async function addUncoveredToDiscount(shop: string, opts: AddDiscountOptions = {}): Promise<AddDiscountResult> {
  const log = opts.onLog ?? (() => {});
  const dryRun = opts.dryRun !== false;
  const pct = opts.discountPct ?? 21;

  const account = await resolveAccountForShop(shop);
  if (!account) throw new Error(`Shop "${shop}" không thuộc tài khoản 4Seller nào.`);
  const principal = `acct:${account.uid}`;
  const shopList = await getShopList(principal);
  const rec = (shopList?.records ?? []).find((s: any) => s.shopName === shop);
  if (!rec) throw new Error(`Không thấy shop "${shop}" trong 4Seller.`);
  const shopId = Number(rec.id);

  // 1. Discount ONGOING của shop (edit cái này). 4Seller yêu cầu shop đã có discount tạo sẵn.
  const page = await getPromotionPage(principal, { discountType: "DIRECT_DISCOUNT", shopId, pageSize: 50 });
  const ongoing = (page.records ?? []).filter((a: any) => a.promotionStatus === "ONGOING")
    .sort((a: any, b: any) => (b.endTime || 0) - (a.endTime || 0));
  const base: AddDiscountResult = {
    shop, shopId, account: account.label, dryRun, activityId: null, activityName: "",
    existing: 0, addable: 0, added: 0, skuAdded: 0, sample: [],
  };
  if (!ongoing.length) {
    log(`[${shop}] ⚠️ Không có Product Discount ONGOING — bỏ (shop cần tạo discount trước).`);
    return { ...base, note: "no-ongoing-discount" };
  }
  const act = ongoing[0];
  log(`[${shop}] discount id=${act.id} "${act.activityName}" (${act.promotionStatus})`);

  // 2. Meta + sp CŨ đang trong discount
  const info = await getActivityInfo(principal, act.id);
  const existingProducts: any[] = Array.isArray(info?.products) ? info.products : [];

  // 3. Sp đủ điều kiện THÊM (đã ẩn overlapping)
  const elig = await discountEligibleProducts(principal, { shopId, startTime: info.beginTime, endTime: info.endTime, pageSize: 100 });
  let addRecords = elig?.records ?? [];
  if (opts.limit && opts.limit > 0) addRecords = addRecords.slice(0, opts.limit);
  log(`[${shop}] sp cũ=${existingProducts.length} · sp thêm được=${elig?.records?.length ?? 0}${opts.limit ? ` (cap ${opts.limit})` : ""}`);

  base.activityId = Number(act.id); base.activityName = act.activityName;
  base.existing = existingProducts.length; base.addable = elig?.records?.length ?? 0;

  if (!addRecords.length) {
    log(`[${shop}] ✅ Không có sp nào để thêm (mọi sp đã có discount).`);
    return base;
  }

  // 4. Sp MỚI: mỗi sku discount = pct% (field `discount` chuỗi — KHÁC flash dùng activityPriceAmount)
  const newProducts = addRecords.map((r: any) => ({
    ...r,
    skus: (r.skus ?? []).map((s: any) => ({ ...s, hasAdd: 1, discount: String(pct), activityPriceAmount: null })),
  }));
  // Giữ NGUYÊN sp cũ (không đụng discount hiện có) + thêm sp mới.
  const products = [...existingProducts, ...newProducts];
  const skuAdded = newProducts.reduce((n: number, p: any) => n + (p.skus?.length ?? 0), 0);
  const payload = {
    id: act.id, shopId, shopCurrency: info.shopCurrency ?? "", activityName: info.activityName,
    beginTime: info.beginTime, endTime: info.endTime, discountType: "DIRECT_DISCOUNT",
    productLevel: info.productLevel ?? "VARIATION", products,
  };
  base.added = newProducts.length; base.skuAdded = skuAdded;
  base.sample = newProducts.slice(0, 5).map((r: any) => ({
    productId: String(r.productId), name: String(r.productName || "").slice(0, 40),
    skus: r.skus?.length ?? 0, discount: `${pct}%`,
  }));

  if (dryRun) {
    log(`[${shop}] DRY-RUN: thêm ${newProducts.length} sp (${skuAdded} variation) @ ${pct}% vào discount ${act.id} (tổng ${products.length} sp)`);
    return { ...base, payload };
  }
  log(`[${shop}] ▶ UPDATE discount ${act.id}: +${newProducts.length} sp @ ${pct}% (tổng ${products.length})…`);
  await saveActivity(principal, payload); // throw nếu code!=0
  log(`[${shop}] ✅ Đã thêm sp vào discount.`);
  return { ...base, updated: true };
}
