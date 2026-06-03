/**
 * Bắt số liệu đánh giá sản phẩm từ BFF API nội bộ SHEIN khi load trang detail:
 *   /bff-api/product/get_goods_detail_realtime_data  →  info chứa:
 *     - last90DaysSoldNum  ("6.6k+", "200+")  → SOLD 90 ngày
 *     - commentNumShow / comment_num           → số review
 *     - comment_rank_average                   → rating
 *     - fiveStarRating…                        → phân bố sao
 *
 * Cách dùng: attachStatsCapture(page) TRƯỚC khi goto → sau khi load đọc .stats.
 */
import type { Page } from "playwright-core";

export interface ProductStats {
  /** Chuỗi gốc SHEIN hiển thị, vd "6.6k+" */
  soldText: string | null;
  /** Sold đã parse ra số, vd 6600 */
  soldNum: number | null;
  reviewCount: number | null;
  rating: number | null;
  fiveStarPct: number | null;
}

/** "6.6k+" → 6600, "200+" → 200, "1.2m" → 1200000, "549" → 549 */
export function parseSold(s: any): number | null {
  if (s === null || s === undefined) return null;
  const str = String(s).toLowerCase().replace(/,/g, "").trim();
  const m = str.match(/([\d.]+)\s*([km])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "k") n *= 1000;
  else if (m[2] === "m") n *= 1_000_000;
  return Math.round(n);
}

function deepFind(o: any, key: string, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 7) return undefined;
  if (o[key] !== undefined && o[key] !== null && o[key] !== "") return o[key];
  for (const k of Object.keys(o)) {
    const r = deepFind(o[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

export interface StatsCapture {
  stats: ProductStats;
  detach: () => void;
}

/**
 * @param goodsId  id sản phẩm chính (từ URL) để ưu tiên đúng response (trang
 *                 còn load realtime của sp gợi ý). Nếu rỗng → lấy response đầu.
 */
export function attachStatsCapture(page: Page, goodsId?: string): StatsCapture {
  const stats: ProductStats = {
    soldText: null,
    soldNum: null,
    reviewCount: null,
    rating: null,
    fiveStarPct: null,
  };

  const onResp = async (res: any) => {
    try {
      if (!/get_goods_detail_realtime_data/.test(res.url())) return;
      const j = await res.json().catch(() => null);
      const info = j?.info;
      if (!info) return;
      // Ưu tiên đúng sản phẩm chính
      const respGoodsId = String(deepFind(info, "goods_id") ?? "");
      if (goodsId && respGoodsId && respGoodsId !== goodsId && stats.soldText) return;

      const soldText = deepFind(info, "last90DaysSoldNum");
      if (soldText && (stats.soldText === null || respGoodsId === goodsId)) {
        stats.soldText = String(soldText);
        stats.soldNum = parseSold(soldText);
      }
      const review =
        deepFind(info, "comment_num_show") ??
        deepFind(info, "commentNumShow") ??
        deepFind(info, "comment_num");
      const reviewNum = parseSold(review);
      if (reviewNum !== null && (stats.reviewCount === null || respGoodsId === goodsId)) {
        stats.reviewCount = reviewNum;
      }
      const rating = deepFind(info, "comment_rank_average");
      if (rating && (stats.rating === null || respGoodsId === goodsId)) {
        const r = parseFloat(String(rating));
        if (Number.isFinite(r)) stats.rating = r;
      }
      const five = deepFind(info, "fiveStarRating");
      if (five && stats.fiveStarPct === null) {
        const f = parseFloat(String(five));
        if (Number.isFinite(f)) stats.fiveStarPct = f;
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResp);
  return { stats, detach: () => page.off("response", onResp) };
}
