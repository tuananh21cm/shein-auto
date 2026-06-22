/**
 * DropScore (Niche Lab P1) — chấm "ngách ngon cho DROPSHIP" theo đúng ràng buộc:
 *   - trend       : đang lên trên TikTok (demandFit / Kalodata)
 *   - cheap       : giá GỐC SHEIN thấp → ít vốn stock kho
 *   - refundSafe  : ít refund — true-to-size cao + rating cao + hàng local + ÍT CẦU KỲ (theo nhóm)
 *   - supply      : SHEIN đủ hàng win để test
 *
 * Dùng data sẵn có: research_niche, research_product, research_candidate (validate), kalodata.
 */
import { getDb } from "../../state/db";
import { researchConfig } from "../../config/appConfig";
import { kalodataStore } from "../../state/kalodataStore";
import { matchNicheDemand } from "./demandFit";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const DEF = {
  weights: { trend: 0.3, cheap: 0.25, refundSafe: 0.3, supply: 0.15 },
  cheap: { idealCost: 8, maxCost: 25 },
  refund: { fitMin: 80, ratingMin: 4.5 },
  groupSimplicity: {} as Record<string, number>,
};

export interface DropScored {
  nicheKey: string;
  group: string;
  dropScore: number;
  trend: number;
  cheap: number;
  refundSafe: number;
  supply: number;
  // chi tiết
  medianCost: number | null;     // giá gốc SHEIN trung vị (USD)
  demandCategory: string | null;
  trueToSize: number | null;
  rating: number | null;
  pctLocal: number | null;       // 0..1
  validatedCount: number;
  supplyCount: number;
  heatScore: number;
}

function cheapScore(cost: number | null, c: { idealCost: number; maxCost: number }): number {
  if (cost == null) return 50;
  if (cost <= c.idealCost) return 100;
  if (cost >= c.maxCost) return 20;
  return Math.round(100 - ((cost - c.idealCost) / (c.maxCost - c.idealCost)) * 80);
}

export function computeDropScores(day: string): DropScored[] {
  const db = getDb();
  const cfg = researchConfig();
  const ds = { ...DEF, ...(cfg.dropScore ?? {}) };

  const niches = db.prepare(`SELECT * FROM research_niche WHERE day = ? ORDER BY heat_score DESC`).all(day) as any[];
  if (!niches.length) return [];

  const kaloDay = kalodataStore.latestDay();
  const kaloCats = kaloDay ? kalodataStore.listCategories(kaloDay) : [];

  const out: DropScored[] = [];
  for (const n of niches) {
    // ── trend (demand TikTok) ──
    const dm = matchNicheDemand({ key: n.niche_key, group: n.niche_group, query: n.query }, kaloCats);

    // ── cheap (giá gốc SHEIN trung vị) ──
    const prices = (db.prepare(
      `SELECT price FROM research_product WHERE day = ? AND niche_key = ? AND price IS NOT NULL`
    ).all(day, n.niche_key) as any[]).map((r) => r.price as number);
    const medianCost = median(prices);
    const cheap = cheapScore(medianCost, ds.cheap);

    // ── refundSafe ──
    const rat = db.prepare(
      `SELECT AVG(rating) r FROM research_product WHERE day = ? AND niche_key = ? AND rating IS NOT NULL`
    ).get(day, n.niche_key) as any;
    const val = db.prepare(`
      SELECT AVG(true_to_size) tts,
             AVG(CASE WHEN is_local=1 THEN 1.0 WHEN is_local=0 THEN 0.0 ELSE NULL END) loc,
             COUNT(validated_at) vc
      FROM research_candidate WHERE day = ? AND niche_key = ?
    `).get(day, n.niche_key) as any;

    const ttsScore = val?.tts != null ? clamp(val.tts) : 70;            // thiếu fit → trung tính
    const ratingScore = rat?.r != null ? clamp((rat.r / 5) * 100) : 60;
    const localScore = val?.loc != null ? clamp(val.loc * 100) : 50;
    const simplicity = ds.groupSimplicity[n.niche_group] ?? 60;
    const refundSafe = Math.round(ttsScore * 0.35 + ratingScore * 0.25 + localScore * 0.2 + simplicity * 0.2);

    // ── supply (SHEIN đủ hàng win) ──
    const supply = Math.round(clamp(n.heat_score * 0.6 + Math.min(100, n.supply_count * 2) * 0.4));

    const dropScore = Math.round(
      dm.demandFit * ds.weights.trend + cheap * ds.weights.cheap + refundSafe * ds.weights.refundSafe + supply * ds.weights.supply
    );

    out.push({
      nicheKey: n.niche_key, group: n.niche_group, dropScore,
      trend: dm.demandFit, cheap, refundSafe, supply,
      medianCost: medianCost != null ? Math.round(medianCost * 100) / 100 : null,
      demandCategory: dm.matchedName,
      trueToSize: val?.tts != null ? Math.round(val.tts) : null,
      rating: rat?.r != null ? Math.round(rat.r * 100) / 100 : null,
      pctLocal: val?.loc != null ? Math.round(val.loc * 100) / 100 : null,
      validatedCount: val?.vc ?? 0,
      supplyCount: n.supply_count, heatScore: n.heat_score,
    });
  }
  out.sort((a, b) => b.dropScore - a.dropScore);
  return out;
}
