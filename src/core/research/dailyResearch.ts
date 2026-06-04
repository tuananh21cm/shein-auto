/**
 * dailyResearch — vòng research win hằng ngày (P1, route "Best-seller sweep").
 *
 * Luồng:
 *   1. Với mỗi ngách seed (config/research.json) → searchProducts RapidAPI US.
 *   2. Chấm winScore từng sp → rollup nhiệt ngách → chấm opportunityScore.
 *   3. Lưu snapshot research_product + research_niche (Signal Store).
 *   4. Chọn candidate: lọc ngưỡng, dedup theo goodsId (giữ điểm cao nhất),
 *      cap maxPerNiche, lấy targetCount → sinh lý do rule-based → lưu.
 *
 * Demand layer (Kalodata/weather/trend) chưa cắm → demandFit trung tính 50.
 * Làm giàu sold thật qua Kiki là bước riêng (enrichCandidates, P2).
 */
import { researchConfig } from "../../config/appConfig";
import { searchProducts } from "../../services/shein/client";
import { scoreWin, type WinScored } from "../winScore";
import { rollupNiche, type NicheRollup } from "./nicheScore";
import { scoreOpportunity } from "./opportunityScore";
import {
  researchStore,
  today,
  type ProductSnapshot,
  type NicheSnapshot,
  type Candidate,
} from "../../state/researchStore";

export interface DailyResearchOptions {
  day?: string;
  onLog?: (msg: string) => void;
  /** Bỏ qua ngách lỗi thay vì throw (mặc định true). */
  continueOnError?: boolean;
}

export interface DailyResearchResult {
  day: string;
  nichesScanned: number;
  productsScored: number;
  candidates: number;
  topNiches: { key: string; heat: number; supply: number }[];
  errors: { niche: string; error: string }[];
}

interface ScoredProduct extends WinScored {
  nicheKey: string;
  nicheGroup: string;
  finalPrice: number | null;
  marginScore: number;
  opportunityScore: number;
}

/** Lý do rule-based vì sao sp được chọn (AI sẽ thay/đẹp hoá ở P4). */
function buildReason(p: ScoredProduct, niche: NicheRollup): string {
  const parts: string[] = [];
  parts.push(`Win ${p.winScore} (${p.winTier})`);
  if (p.commentNum > 0) parts.push(`${p.commentNum >= 1000 ? (p.commentNum / 1000).toFixed(1) + "k" : p.commentNum} review`);
  if (p.rating) parts.push(`★${p.rating}`);
  parts.push(`ngách nóng ${niche.heatScore}`);
  if (p.finalPrice !== null) parts.push(`giá bán ~$${p.finalPrice}`);
  if (p.discountPct) parts.push(`-${p.discountPct}%`);
  return parts.join(" · ");
}

export async function runDailyResearch(opts: DailyResearchOptions = {}): Promise<DailyResearchResult> {
  const cfg = researchConfig();
  const day = opts.day ?? today();
  const log = opts.onLog ?? (() => {});
  const continueOnError = opts.continueOnError ?? true;

  const allScored: ScoredProduct[] = [];
  const nicheSnapshots: NicheSnapshot[] = [];
  const errors: { niche: string; error: string }[] = [];

  for (const niche of cfg.niches) {
    try {
      log(`🔎 [${niche.key}] search "${niche.query}"…`);
      const res = await searchProducts(niche.query, {
        perPage: cfg.perNichePerPage,
        country: cfg.country,
      });
      const wins: WinScored[] = res.products.map(scoreWin);
      const rollup = rollupNiche(wins);

      const scored: ScoredProduct[] = wins.map((w) => {
        const opp = scoreOpportunity({ win: w, nicheHeat: rollup.heatScore });
        return {
          ...w,
          nicheKey: niche.key,
          nicheGroup: niche.group,
          finalPrice: opp.finalPrice,
          marginScore: opp.marginScore,
          opportunityScore: opp.opportunityScore,
        };
      });
      allScored.push(...scored);

      nicheSnapshots.push({
        nicheKey: niche.key,
        nicheGroup: niche.group,
        query: niche.query,
        supplyCount: rollup.supplyCount,
        avgTopWin: rollup.avgTopWin,
        hotShare: rollup.hotShare,
        medianPrice: rollup.medianPrice,
        marginBand: rollup.marginBand,
        heatScore: rollup.heatScore,
      });
      log(`   ✓ ${scored.length} sp · nhiệt ngách ${rollup.heatScore} · hot ${rollup.hotShare}%`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      errors.push({ niche: niche.key, error: msg });
      log(`   ✗ ${niche.key} lỗi: ${msg}`);
      if (!continueOnError) throw e;
    }
  }

  // ── Lưu snapshot ──
  const productSnapshots: ProductSnapshot[] = allScored
    .filter((p) => p.goodsId)
    .map((p) => ({
      goodsId: p.goodsId,
      nicheKey: p.nicheKey,
      nicheGroup: p.nicheGroup,
      name: p.name,
      image: p.image,
      url: p.url ?? "",
      storeCode: p.storeCode ?? null,
      price: p.price,
      retailPrice: p.retailPrice,
      discountPct: p.discountPct,
      finalPrice: p.finalPrice,
      commentNum: p.commentNum,
      rating: p.rating,
      soldNum: null,
      winScore: p.winScore,
      winTier: p.winTier,
      marginScore: p.marginScore,
      opportunityScore: p.opportunityScore,
      source: p.source,
    }));
  researchStore.saveProducts(day, productSnapshots);
  researchStore.saveNiches(day, nicheSnapshots);

  // ── Chọn candidate ──
  const niceMap = new Map(nicheSnapshots.map((n) => [n.nicheKey, n]));
  // Dedup theo goodsId — 1 sp có thể xuất hiện ở nhiều ngách → giữ điểm cao nhất.
  const bestByGoods = new Map<string, ScoredProduct>();
  for (const p of allScored) {
    if (!p.goodsId) continue;
    const prev = bestByGoods.get(p.goodsId);
    if (!prev || p.opportunityScore > prev.opportunityScore) bestByGoods.set(p.goodsId, p);
  }

  const cc = cfg.candidate;
  const pool = [...bestByGoods.values()]
    .filter((p) => p.opportunityScore >= cc.minOpportunity)
    .sort((a, b) => b.opportunityScore - a.opportunityScore);

  const perNicheCount = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const p of pool) {
    if (picked.length >= cc.targetCount) break;
    const n = perNicheCount.get(p.nicheKey) ?? 0;
    if (n >= cc.maxPerNiche) continue;
    perNicheCount.set(p.nicheKey, n + 1);
    const rollup = niceMap.get(p.nicheKey)!;
    picked.push({
      id: `${day}:${p.goodsId}`,
      day,
      goodsId: p.goodsId,
      nicheKey: p.nicheKey,
      nicheGroup: p.nicheGroup,
      name: p.name,
      image: p.image,
      url: p.url ?? "",
      storeCode: p.storeCode ?? null,
      price: p.price,
      finalPrice: p.finalPrice,
      commentNum: p.commentNum,
      rating: p.rating,
      soldNum: null,
      winScore: p.winScore,
      winTier: p.winTier,
      opportunityScore: p.opportunityScore,
      reason: buildReason(p, rollupFor(rollup)),
      aiReason: null,
      status: "new",
      targetShop: null,
      soldText: null,
      rankText: null,
      enrichedAt: null,
      createdAt: 0,
      updatedAt: 0,
    });
  }
  researchStore.saveCandidates(day, picked);

  const topNiches = [...nicheSnapshots]
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 5)
    .map((n) => ({ key: n.nicheKey, heat: n.heatScore, supply: n.supplyCount }));

  log(
    `✅ Research ${day}: ${nicheSnapshots.length} ngách · ${productSnapshots.length} sp · ${picked.length} candidate`
  );

  return {
    day,
    nichesScanned: nicheSnapshots.length,
    productsScored: productSnapshots.length,
    candidates: picked.length,
    topNiches,
    errors,
  };
}

/** NicheSnapshot → NicheRollup shape cho buildReason. */
function rollupFor(n: NicheSnapshot): NicheRollup {
  return {
    supplyCount: n.supplyCount,
    avgTopWin: n.avgTopWin,
    hotShare: n.hotShare,
    medianPrice: n.medianPrice,
    marginBand: n.marginBand,
    heatScore: n.heatScore,
  };
}
