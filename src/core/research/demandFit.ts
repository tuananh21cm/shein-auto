/**
 * demandFit (P3) — chấm "khớp nhu cầu TikTok US" cho 1 ngách, từ demand Kalodata.
 * Thay cho hằng số 50 trung tính trong opportunityScore.
 *
 * Cơ chế: map niche (key+group) → category Kalodata khớp nhất (theo keyword) →
 * tính điểm từ: growth_rate (đang lên?), trend_slope (đà), độ tập trung top10
 * (thấp = dễ chen), và độ lớn revenue (cầu thật). 0-100.
 */
import type { KaloCategory } from "../../services/kalodata/client";
import type { ResearchNiche } from "../../config/appConfig";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export { isFashionCategory } from "./fashionFilter";

// Mở rộng keyword cho từng group/niche → tên category Kalodata.
const GROUP_SYNONYMS: Record<string, string[]> = {
  dresses: ["dress"],
  sets: ["set", "suit", "co-ord", "two piece"],
  tops: ["top", "cami", "tank", "t-shirt", "tee", "shirt", "blouse", "corset"],
  bottoms: ["pant", "trouser", "short", "jean", "denim", "bottom", "legging", "skirt"],
  beachwear: ["swim", "bikini", "beach", "cover up"],
  underwear: ["underwear", "lingerie", "shapewear", "bra", "intimate"],
};

// Token quá chung / dễ match nhầm → bỏ (vd "one" khớp "phones", "set" từ "bikini set").
const STOPWORDS = new Set([
  "one", "two", "three", "piece", "pieces", "women", "womens", "woman", "men", "mens",
  "summer", "spring", "casual", "new", "style", "slim", "fit", "high", "waist", "going",
  "out", "daily", "vacation", "beach", "party", "sexy", "cute",
]);

const tokens = (s: string): string[] =>
  (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));

/** Keyword của 1 niche để match category. CHỈ dùng key + group synonym (KHÔNG dùng
 *  query — query nhiễu, vd "bikini set" → "set" match nhầm "Jewelry Sets"). */
export function nicheKeywords(niche: ResearchNiche): string[] {
  const kw = new Set<string>();
  for (const t of tokens(niche.key)) kw.add(t);
  for (const s of GROUP_SYNONYMS[niche.group] ?? []) if (!STOPWORDS.has(s)) kw.add(s);
  return [...kw];
}

// Match keyword theo ĐẦU TỪ (\b) để tránh khớp giữa từ ("one" ⊄ "phones").
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameHas = (name: string, kw: string): boolean =>
  new RegExp("\\b" + escRe(kw), "i").test(name);

export interface DemandMatch {
  demandFit: number;          // 0-100
  category: KaloCategory | null;
  matchedName: string | null;
}

/** Tìm category Kalodata khớp nhất + chấm demandFit. */
export function matchNicheDemand(niche: ResearchNiche, categories: KaloCategory[]): DemandMatch {
  if (!categories.length) return { demandFit: 50, category: null, matchedName: null };
  const kws = nicheKeywords(niche);

  // Ứng viên: category name chứa ÍT NHẤT 1 keyword. Chọn theo (số keyword khớp, rồi revenue).
  let best: KaloCategory | null = null;
  let bestScore = -1;
  for (const c of categories) {
    const name = c.name.toLowerCase();
    let hits = 0;
    for (const k of kws) if (nameHas(name, k)) hits++;
    if (hits === 0) continue;
    const score = hits * 1e15 + (c.revenue ?? 0); // ưu tiên nhiều keyword, rồi revenue lớn
    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Fallback: L1 Womenswear/Menswear nếu không match cụ thể.
  if (!best) {
    best = categories.find((c) => /womenswear|women's apparel|apparel & accessories/i.test(c.name) && c.level === "1")
      ?? categories.find((c) => /women/i.test(c.name)) ?? null;
  }
  if (!best) return { demandFit: 50, category: null, matchedName: null };

  return { demandFit: scoreDemand(best, categories), category: best, matchedName: best.name };
}

/** Chấm demandFit 0-100 từ 1 category. */
function scoreDemand(c: KaloCategory, all: KaloCategory[]): number {
  // growth: -20% → 20đ, 0% → 50đ, +50% → ~90đ
  const growthScore = c.growthRate != null ? clamp(50 + c.growthRate * 80) : 50;
  // trend slope: 1.0 → 50, 1.3 → ~80, 0.8 → ~20
  const trendScore = c.trendSlope != null ? clamp(50 + (c.trendSlope - 1) * 130) : 50;
  // concentration: top10 thấp = dễ chen. 20% → 80đ, 60% → 40đ
  const concScore = c.top10Ratio != null ? clamp(100 - c.top10Ratio * 100) : 50;
  // revenue: rank trong tập (cầu lớn). top → 100, đáy → ~30
  const revs = all.map((x) => x.revenue ?? 0).sort((a, b) => b - a);
  const rank = c.revenue != null ? revs.indexOf(c.revenue) : revs.length;
  const revScore = clamp(100 - (rank / Math.max(all.length, 1)) * 70);

  return Math.round(growthScore * 0.35 + trendScore * 0.25 + concScore * 0.2 + revScore * 0.2);
}
