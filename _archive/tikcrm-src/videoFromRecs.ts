/**
 * Phase 6 — Gen video từ đề xuất AI (render, KHÔNG auto-publish).
 *
 * Lấy list "nên làm video" của AI (theo tên SP) → map sang product_id (listing TikCRM) →
 * tra 4Seller lấy listingId + ảnh → enqueue vào video studio. Pipeline render sẵn có
 * (images→script→tts→render) chạy tự động qua cron; publish để riêng, không đụng.
 * Chỉ shop có 4Seller mới render được (cần ảnh listing).
 */
import { getShopList, getListingPage } from "../fourseller/client";
import { videoQueue } from "../../core/videoStudio/videoQueue";
import { getShopFourSeller, getDaySnapshot, dayKey } from "./dailyStore";
import { getListings } from "./listingsStore";

const norm = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

export interface GenVideoResult {
  ok: boolean;
  error?: string;
  shop_4seller?: string;
  queued?: number;
  skipped?: string[];
  video_ids?: number[];
}

/** Enqueue video cho các SP AI đề xuất của 1 shop. onLog stream tiến độ. */
export async function enqueueVideosFromRecs(code: string, onLog: (m: string) => void = () => {}): Promise<GenVideoResult> {
  const fs = getShopFourSeller(code);
  if (!fs) return { ok: false, error: "Shop chưa map 4Seller — không lấy được ảnh listing để render." };

  const recs = (getDaySnapshot(code, dayKey()).recommendations?.video ?? []) as { san_pham: string }[];
  if (!recs.length) return { ok: false, error: "Chưa có đề xuất video (chạy AI trước)." };

  const listings = getListings(code).listings ?? [];
  const principal = `acct:${fs.uid}`;

  // shopName 4Seller (video queue định danh theo tên này)
  const shopList = await getShopList(principal);
  const rec4s = (shopList?.records ?? []).find((s: any) => String(s.id) === String(fs.shopId));
  const shop4s = rec4s?.shopName;
  if (!shop4s) return { ok: false, error: "Không tìm thấy shop trên 4Seller." };

  // index listing active: productId → { listingId, title, image }
  const index = new Map<string, { listingId: string; title: string; image: string }>();
  for (let page = 1; page <= 20; page++) {
    const res = await getListingPage(principal, { shopId: Number(fs.shopId), status: "active", pageCurrent: page, pageSize: 100 });
    for (const r of res.records ?? []) {
      index.set(String(r.productId), {
        listingId: String(r.id), title: String(r.title ?? (r as any).productName ?? ""),
        image: String((r as any).mainImage ?? ""),
      });
    }
    if ((res.records?.length ?? 0) < 100) break;
  }

  // map tên SP (AI) → listing TikCRM → product_id → listing 4Seller
  const items: { productId: string; listingId: string; title: string }[] = [];
  const skipped: string[] = [];
  for (const v of recs) {
    const nm = norm(v.san_pham);
    const listing = listings.find((l: any) => { const ln = norm(l.product_name); return ln === nm || ln.startsWith(nm); });
    const pid = listing?.product_id;
    const fsl = pid ? index.get(String(pid)) : undefined;
    if (fsl) items.push({ productId: String(pid), listingId: fsl.listingId, title: fsl.title || listing.product_name });
    else skipped.push(v.san_pham);
  }
  if (!items.length) return { ok: false, error: "Không map được SP đề xuất sang listing 4Seller active.", skipped };

  const ids = videoQueue.enqueue(shop4s, items);
  onLog(`✓ ${code} → ${shop4s}: enqueue ${ids.length} video (bỏ ${skipped.length}).`);
  return { ok: true, shop_4seller: shop4s, queued: ids.length, skipped, video_ids: ids };
}
