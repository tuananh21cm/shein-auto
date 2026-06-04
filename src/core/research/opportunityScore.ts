/**
 * opportunityScore — điểm "đáng đăng" tổng hợp cho 1 sản phẩm SHEIN xét theo
 * góc nhìn dropship-TikTok US. Khác winScore (chỉ đo độ hot của sp trên SHEIN),
 * opportunityScore còn cân:
 *   - nicheHeat   : ngách đang nóng cỡ nào (từ research_niche rollup)
 *   - marginScore : giá bán dự kiến (sau công thức pricing.json) có lọt "sweet
 *                   spot" mua bốc đồng TikTok không
 *   - demandFit   : khớp nhu cầu thị trường (Kalodata/weather/trend) — P1 chưa có
 *                   → trung tính 50, cắm sau ở P3.
 *
 * Trọng số đọc từ config/research.json → chỉnh không cần build lại.
 */
import { researchConfig, computeFinalPrice } from "../../config/appConfig";
import type { WinScored } from "../winScore";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Giá bán dự kiến trên TikTok (USD) từ giá gốc SHEIN. NULL nếu không có giá. */
export function projectFinalPrice(price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const f = computeFinalPrice(price);
  return Number.isFinite(f) ? Math.round(f * 100) / 100 : null;
}

/**
 * marginScore 0-100 theo "sweet spot" giá bán:
 *   - trong [sweetLow, sweetHigh] → 100 (vùng dễ chốt đơn impulse)
 *   - dưới sweetLow → vẫn tốt nhưng nghi ngờ biên/chất lượng → 60→100
 *   - sweetHigh..hardMax → giảm tuyến tính 100→0
 *   - > hardMax → 0 (đắt, khó bán dropship)
 */
export function marginScore(finalPrice: number | null): number {
  if (finalPrice === null || !Number.isFinite(finalPrice)) return 0;
  const { sweetLow, sweetHigh, hardMax } = researchConfig().margin;
  if (finalPrice >= sweetLow && finalPrice <= sweetHigh) return 100;
  if (finalPrice > hardMax) return 0;
  if (finalPrice < sweetLow) {
    const ratio = sweetLow > 0 ? finalPrice / sweetLow : 1; // 0..1
    return clamp(60 + ratio * 40);
  }
  // sweetHigh < finalPrice <= hardMax
  const span = Math.max(hardMax - sweetHigh, 1);
  const t = (finalPrice - sweetHigh) / span;
  return clamp(100 * (1 - t));
}

export interface OpportunityInput {
  win: WinScored;
  /** nhiệt ngách 0-100 (từ rollupNiche) */
  nicheHeat: number;
  /** 0-100, mặc định 50 (trung tính) cho tới khi có tầng demand */
  demandFit?: number;
}

export interface OpportunityScored {
  finalPrice: number | null;
  marginScore: number;
  demandFit: number;
  opportunityScore: number;
}

/** Chấm opportunityScore. Cần winScore đã tính sẵn trong `win`. */
export function scoreOpportunity(inp: OpportunityInput): OpportunityScored {
  const w = researchConfig().weights;
  const finalPrice = projectFinalPrice(inp.win.price);
  const margin = marginScore(finalPrice);
  const demandFit = clamp(inp.demandFit ?? 50);
  const nicheHeat = clamp(inp.nicheHeat);

  const opportunityScore = Math.round(
    inp.win.winScore * w.win +
      nicheHeat * w.nicheHeat +
      margin * w.margin +
      demandFit * w.demandFit
  );

  return { finalPrice, marginScore: margin, demandFit, opportunityScore };
}
