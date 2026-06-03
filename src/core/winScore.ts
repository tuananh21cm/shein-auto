/**
 * Chấm điểm "win" cho 1 sản phẩm SHEIN.
 *
 * SHEIN không lộ sold count chính xác → dùng proxy có trong response:
 *   - commentNum (số review)  ~ lượng bán  → trọng số CAO nhất
 *   - rating (0-5)            ~ chất lượng
 *   - discountPct             ~ độ hấp dẫn giá
 *
 * Trả winScore 0-100 + tier để xếp hạng / lọc.
 */
import type { SheinProduct } from "../services/shein/types";

export type WinTier = "hot" | "good" | "normal" | "weak";

export interface WinScored extends SheinProduct {
  winScore: number;
  winTier: WinTier;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Quy đổi count → 0-100 theo thang log với mốc `maxAt` ứng 100đ. */
function logScore(count: number, maxAt: number): number {
  if (count <= 0) return 0;
  return clamp((Math.log10(count + 1) / Math.log10(maxAt)) * 100);
}

/**
 * Chấm winScore. Nếu có `soldNum` (số bán thật từ Kiki BFF) → ưu tiên cao nhất.
 * Nếu không (chỉ có từ API search) → dùng review/rating/discount như cũ.
 */
export function scoreWin(p: SheinProduct & { soldNum?: number | null }): WinScored {
  const ratingScore = p.rating !== null ? clamp((p.rating / 5) * 100) : 50;
  const discountScore = p.discountPct !== null ? clamp(p.discountPct) : 0;
  const hasSold = typeof p.soldNum === "number" && p.soldNum > 0;

  let winScore: number;
  if (hasSold) {
    // Có sold thật: sold ~50k = 100đ. sold là tín hiệu mạnh nhất.
    const soldScore = logScore(p.soldNum as number, 50000);
    const reviewScore = logScore(p.commentNum, 3000);
    winScore = Math.round(soldScore * 0.45 + reviewScore * 0.2 + ratingScore * 0.2 + discountScore * 0.15);
  } else {
    const reviewScore = logScore(p.commentNum, 3000);
    winScore = Math.round(reviewScore * 0.55 + ratingScore * 0.3 + discountScore * 0.15);
  }

  let winTier: WinTier;
  const strong = hasSold ? (p.soldNum as number) >= 500 : p.commentNum >= 100;
  if (winScore >= 70 && strong) winTier = "hot";
  else if (winScore >= 50) winTier = "good";
  else if (winScore >= 30) winTier = "normal";
  else winTier = "weak";

  return { ...p, winScore, winTier };
}

/** Chấm + sắp xếp giảm dần theo winScore. */
export function rankByWin(products: SheinProduct[]): WinScored[] {
  return products.map(scoreWin).sort((a, b) => b.winScore - a.winScore);
}
