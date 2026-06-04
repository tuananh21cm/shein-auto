/**
 * validateProduct — cổng kiểm định sâu (pure). Nhận tín hiệu detail → verdict.
 *
 * Hard gate (fail bất kỳ → REJECT):
 *   - rating < minRating (nếu có rating)
 *   - true-to-size < fitMin (CHỈ khi lấy được; thiếu → bỏ qua tiêu chí)
 *   - sold < minSold (nếu có sold)
 *   - nghi ngờ bản quyền (tên chứa brand licensed)
 * WATCH (không reject nhưng cần soi):
 *   - không phải local (inter/unknown) — ưu tiên local
 *   - thiếu rating, giảm giá quá sâu, hoặc validationScore thấp
 * PASS: qua hết.
 */
import { researchConfig } from "../../config/appConfig";
import type { DetailSignals } from "../../services/kiki/detailSignals";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const logScore = (count: number, maxAt: number) =>
  count <= 0 ? 0 : clamp((Math.log10(count + 1) / Math.log10(maxAt)) * 100);

export type Verdict = "PASS" | "WATCH" | "REJECT";

export interface ValidationInput {
  name: string;
  rating: number | null;
  fiveStarPct: number | null;
  soldNum: number | null;
  discountPct: number | null;
  signals: DetailSignals;
}

export interface ValidationResult {
  verdict: Verdict;
  validationScore: number;
  isLocal: boolean | null;
  shipMode: "local" | "international" | "unknown";
  shipDays: number | null;
  trueToSize: number | null;
  ugcCount: number | null;
  ipRisk: boolean;
  badges: string[];
  breakdown: { label: string; ok: boolean | null; detail: string }[];
  reasons: string[];
}

const DEFAULTS = {
  minRating: 4.0, minSold: 100, fitMin: 80, localShipMaxDays: 12,
  watchScore: 60, deepDiscountPct: 75, minUgcForContent: 1, ipBrands: [] as string[],
};

export function validateProduct(inp: ValidationInput): ValidationResult {
  const v = { ...DEFAULTS, ...(researchConfig().validation ?? {}) };
  const s = inp.signals;

  // ── Local vs international ──
  let shipMode: ValidationResult["shipMode"] = "unknown";
  if (s.shipDaysMin != null && s.shipDaysMin <= v.localShipMaxDays) shipMode = "local";
  else if (s.seaShipping || (s.shipDaysMin != null && s.shipDaysMin > v.localShipMaxDays)) shipMode = "international";
  const isLocal = shipMode === "unknown" ? null : shipMode === "local";

  // ── IP risk (regex tên) ──
  const lower = (inp.name || "").toLowerCase();
  const ipHit = v.ipBrands.find((b) => b && lower.includes(b.toLowerCase()));
  const ipRisk = Boolean(ipHit);

  // ── validationScore (0-100) ──
  const ratingScore = inp.rating != null ? clamp((inp.rating / 5) * 100) : 50;
  const soldScore = inp.soldNum != null ? logScore(inp.soldNum, 50000) : 40;
  const fitScore = s.trueToSize != null ? clamp(s.trueToSize) : 70; // thiếu → trung tính
  const fiveStar = clamp(inp.fiveStarPct ?? 50);
  const localScore = isLocal === true ? 100 : isLocal === false ? 40 : 60;
  const ugcScore = s.ugcCount != null ? clamp(s.ugcCount * 10) : 30;
  const sizeChartScore = s.hasSizeChart ? 100 : 50;
  const validationScore = Math.round(
    ratingScore * 0.25 + soldScore * 0.2 + fitScore * 0.2 + localScore * 0.15 +
    fiveStar * 0.1 + ugcScore * 0.05 + sizeChartScore * 0.05
  );

  // ── Breakdown + gate ──
  const breakdown: ValidationResult["breakdown"] = [];
  const reasons: string[] = [];
  let reject = false;
  let watch = false;

  // rating
  if (inp.rating != null) {
    const ok = inp.rating >= v.minRating;
    breakdown.push({ label: "Rating", ok, detail: `★${inp.rating} (cần ≥${v.minRating})` });
    if (!ok) { reject = true; reasons.push(`rating ★${inp.rating} < ${v.minRating}`); }
  } else {
    breakdown.push({ label: "Rating", ok: null, detail: "chưa có rating" });
    watch = true; reasons.push("thiếu rating");
  }

  // sold
  if (inp.soldNum != null) {
    const ok = inp.soldNum >= v.minSold;
    breakdown.push({ label: "Sold 90d", ok, detail: `${inp.soldNum} (cần ≥${v.minSold})` });
    if (!ok) { reject = true; reasons.push(`sold ${inp.soldNum} < ${v.minSold}`); }
  } else {
    breakdown.push({ label: "Sold 90d", ok: null, detail: "chưa lấy được sold" });
  }

  // true-to-size — chỉ gate khi có
  if (s.trueToSize != null) {
    const ok = s.trueToSize >= v.fitMin;
    breakdown.push({ label: "True-to-size", ok, detail: `${s.trueToSize}% (cần ≥${v.fitMin}%)` });
    if (!ok) { reject = true; reasons.push(`true-to-size ${s.trueToSize}% < ${v.fitMin}%`); }
  } else {
    breakdown.push({ label: "True-to-size", ok: null, detail: "không lấy được → bỏ qua" });
  }

  // local
  if (shipMode === "local") {
    breakdown.push({ label: "Ship", ok: true, detail: `🏠 Local (~${s.shipDaysMin}d)` });
  } else if (shipMode === "international") {
    breakdown.push({ label: "Ship", ok: false, detail: `✈️ Inter (sea ~${s.shipDaysMin ?? "35-42"}d)` });
    watch = true; reasons.push("hàng international (ship chậm)");
  } else {
    breakdown.push({ label: "Ship", ok: null, detail: "không rõ nguồn ship" });
    watch = true; reasons.push("không rõ local/inter");
  }

  // IP
  breakdown.push({ label: "Bản quyền", ok: !ipRisk, detail: ipRisk ? `⚠️ nghi "${ipHit}"` : "ok" });
  if (ipRisk) { reject = true; reasons.push(`rủi ro bản quyền: ${ipHit}`); }

  // discount sâu
  if (inp.discountPct != null && inp.discountPct >= v.deepDiscountPct) {
    breakdown.push({ label: "Giảm giá", ok: null, detail: `-${inp.discountPct}% (sâu — nghi xả?)` });
    watch = true; reasons.push(`giảm giá sâu -${inp.discountPct}%`);
  }

  if (validationScore < v.watchScore) { watch = true; reasons.push(`điểm kiểm định thấp ${validationScore}`); }

  const verdict: Verdict = reject ? "REJECT" : watch ? "WATCH" : "PASS";

  // ── Badges ──
  const badges: string[] = [];
  if (isLocal === true) badges.push("🏠 Local");
  else if (isLocal === false) badges.push("✈️ Inter");
  if (inp.rating != null) badges.push(`⭐${inp.rating}`);
  if (s.trueToSize != null) badges.push(`📏${s.trueToSize}%`);
  if (inp.soldNum != null) badges.push(`🔥${inp.soldNum >= 1000 ? (inp.soldNum / 1000).toFixed(1) + "k" : inp.soldNum}`);
  if (s.ugcCount && s.ugcCount >= v.minUgcForContent) badges.push(`🎬${s.ugcCount}`);
  if (ipRisk) badges.push("⚠️IP");

  return {
    verdict, validationScore, isLocal, shipMode, shipDays: s.shipDaysMin,
    trueToSize: s.trueToSize, ugcCount: s.ugcCount, ipRisk, badges, breakdown, reasons,
  };
}
