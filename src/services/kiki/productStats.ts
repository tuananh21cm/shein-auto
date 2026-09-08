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

export interface RankInfo {
  /** Banner đầy đủ, vd "No.1 Bestseller" */
  bannerText: string | null;
  /** Hạng số, vd 1 (từ "No.1") */
  rank: number | null;
  /** Mô tả ngách, vd "in 10 Piece Set Women Thongs" */
  nicheText: string | null;
}

export interface RankCapture {
  rank: RankInfo;
  detach: () => void;
}

/**
 * Bắt rank "Bestseller" từ BFF `/bff-api/category/api/get_detail_rank_info`.
 * Cấu trúc (golden-0): info.firstScreenRankInfo.content[].content.props.items[]
 *   .rank_of_goods.list[]  → { scoreStr:"No.1", rankingBannerText, composeIdText }
 * Best-effort: lấy item đầu có rankingBannerText. KHÔNG dùng cho winScore
 * (sold mới là tín hiệu chính) — chỉ để hiển thị/đánh dấu.
 */
export function attachRankCapture(page: Page): RankCapture {
  const rank: RankInfo = { bannerText: null, rank: null, nicheText: null };

  const onResp = async (res: any) => {
    try {
      if (!/get_detail_rank_info/.test(res.url())) return;
      const j = await res.json().catch(() => null);
      const info = j?.info;
      if (!info) return;
      // Tìm list rank_of_goods đầu tiên trong cây
      const lists: any[] = [];
      const walk = (o: any, depth = 0) => {
        if (!o || typeof o !== "object" || depth > 9) return;
        if (Array.isArray(o?.rank_of_goods?.list)) lists.push(o.rank_of_goods.list);
        if (Array.isArray(o)) { for (const it of o) walk(it, depth + 1); return; }
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      };
      walk(info);
      for (const list of lists) {
        const it = list?.[0];
        if (!it) continue;
        const banner = it.rankingBannerText || it.scoreStr;
        if (banner && rank.bannerText === null) {
          rank.bannerText = String(banner);
          const m = String(it.scoreStr ?? banner).match(/No\.?\s*(\d+)/i);
          rank.rank = m ? Number(m[1]) : null;
          rank.nicheText = it.composeIdText ? String(it.composeIdText) : null;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResp);
  return { rank, detach: () => page.off("response", onResp) };
}
