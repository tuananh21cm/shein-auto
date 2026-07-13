/**
 * Đề xuất sản phẩm làm video: candidates tín hiệu view/sold từ listing_views
 * (getFlashCandidates — có đơn / đang lên / nhiều view, kèm reasons) JOIN với
 * listing active trên 4Seller (lấy listingId + mainImage). Pattern principal
 * + shopId GIỐNG flashDeal.ts.
 */
import { getShopList, getListingPage } from "../../services/fourseller/client";
import { resolveAccountForShop } from "../../state/fourSellerAccounts";
import { TiktokDb } from "../../services/tiktok/db";
import { VideoDb } from "../../state/videoDb";

export interface SuggestItem {
  productId: string; listingId: string; title: string; thumb: string; mainImage: string;
  pv: number; avgPerDay: number; orders: number; daysTracked: number;
  reasons: string[]; hasVideo: boolean;
}

export interface ListingLite { listingId: string; title: string; mainImage: string }

/** Pure join để unit-test: candidates × index(productId→listing). */
export function joinCandidatesWithListings(
  candidates: { productId: string; productName: string; pv: number; avgPerDay: number; daysTracked: number; orders: number; reasons: string[] }[],
  index: Map<string, ListingLite>
): { items: Omit<SuggestItem, "hasVideo">[]; unmatched: number } {
  const items: Omit<SuggestItem, "hasVideo">[] = [];
  let unmatched = 0;
  for (const c of candidates) {
    const l = index.get(String(c.productId));
    if (!l) { unmatched++; continue; }
    items.push({
      productId: String(c.productId), listingId: String(l.listingId),
      title: l.title || c.productName,
      thumb: (l.mainImage || "").split("|")[0] ?? "",
      mainImage: l.mainImage || "",
      pv: c.pv, avgPerDay: c.avgPerDay, orders: c.orders, daysTracked: c.daysTracked,
      reasons: c.reasons,
    });
  }
  return { items, unmatched };
}

export async function suggestProducts(shop: string, opts: { limit?: number } = {}): Promise<{
  shop: string; latestDate: string | null; items: SuggestItem[]; unmatched: number;
}> {
  const limit = opts.limit ?? 50;

  // 1. Principal + shopId (giống flashDeal)
  const account = await resolveAccountForShop(shop);
  if (!account) throw new Error(`Shop "${shop}" không thuộc tài khoản 4Seller nào (tab Cookie 4Seller).`);
  const principal = `acct:${account.uid}`;
  const shopList = await getShopList(principal);
  const rec = (shopList?.records ?? []).find((s: any) => s.shopName === shop);
  if (!rec) throw new Error(`Không thấy shop "${shop}" trong 4Seller (tài khoản ${account.label}).`);
  const shopId = Number(rec.id);

  // 2. Candidates từ tín hiệu view/sold
  const tdb = new TiktokDb();
  let cand;
  try { cand = tdb.getFlashCandidates(shop, { limit }); } finally { tdb.close(); }
  if (!cand.candidates.length) return { shop, latestDate: cand.latestDate, items: [], unmatched: 0 };

  // 3. Index listing active theo productId (paginate hết)
  const index = new Map<string, ListingLite>();
  for (let page = 1; page <= 20; page++) {
    const res = await getListingPage(principal, { shopId, status: "active", pageCurrent: page, pageSize: 100 });
    for (const r of res.records ?? []) {
      index.set(String(r.productId), {
        listingId: String(r.id),
        title: String(r.title ?? (r as any).productName ?? ""),
        mainImage: String((r as any).mainImage ?? ""),
      });
    }
    if ((res.records?.length ?? 0) < 100 || index.size >= (res.total ?? 0)) break;
  }

  // 4. Join + cờ hasVideo
  const { items, unmatched } = joinCandidatesWithListings(cand.candidates, index);
  if (unmatched) console.warn(`⚠️ [Suggest] ${unmatched} sp có tín hiệu nhưng không còn active trên 4Seller (${shop})`);
  const vdb = new VideoDb();
  try {
    return {
      shop, latestDate: cand.latestDate, unmatched,
      items: items.map((it) => ({ ...it, hasVideo: vdb.hasReadyVideo(it.productId) })),
    };
  } finally { vdb.close(); }
}
