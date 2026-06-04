/**
 * nicheScore — rollup 1 ngách (tập sp đã chấm winScore) thành chỉ số "nhiệt":
 *   - supplyCount : số sp lấy được (nguồn cung của ngách)
 *   - avgTopWin   : winScore trung bình của top sp (chất lượng đỉnh ngách)
 *   - hotShare    : % sp đạt tier hot/good (độ "ăn khách" lan rộng)
 *   - medianPrice : giá bán dự kiến trung vị (định vị giá ngách)
 *   - marginBand  : marginScore của median price (ngách có dễ markup không)
 *   - heatScore   : 0-100 tổng hợp → so sánh / xếp hạng ngách
 *
 * Dùng để (a) ưu tiên ngách khi chọn candidate, (b) nuôi nicheHeat cho
 * opportunityScore của từng sp trong ngách.
 */
import type { WinScored } from "../winScore";
import { marginScore, projectFinalPrice } from "./opportunityScore";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export interface NicheRollup {
  supplyCount: number;
  avgTopWin: number;
  hotShare: number;
  medianPrice: number | null;
  marginBand: number;
  heatScore: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * @param topN số sp top tính avgTopWin (mặc định 10). Tránh để "đuôi" sp yếu
 *             kéo tụt nhiệt ngách — ta quan tâm đỉnh ngách bán được gì.
 */
export function rollupNiche(products: WinScored[], topN = 10): NicheRollup {
  const supplyCount = products.length;
  if (supplyCount === 0) {
    return { supplyCount: 0, avgTopWin: 0, hotShare: 0, medianPrice: null, marginBand: 0, heatScore: 0 };
  }

  const sorted = [...products].sort((a, b) => b.winScore - a.winScore);
  const top = sorted.slice(0, topN);
  const avgTopWin = Math.round(top.reduce((s, p) => s + p.winScore, 0) / top.length);

  const hotCount = products.filter((p) => p.winTier === "hot" || p.winTier === "good").length;
  const hotShare = Math.round((hotCount / supplyCount) * 100);

  const finalPrices = products
    .map((p) => projectFinalPrice(p.price))
    .filter((x): x is number => x !== null);
  const medianPrice = median(finalPrices);
  const marginBand = marginScore(medianPrice);

  const heatScore = Math.round(avgTopWin * 0.5 + hotShare * 0.3 + marginBand * 0.2);

  return {
    supplyCount,
    avgTopWin,
    hotShare,
    medianPrice: medianPrice === null ? null : Math.round(medianPrice * 100) / 100,
    marginBand,
    heatScore: clamp(heatScore),
  };
}
