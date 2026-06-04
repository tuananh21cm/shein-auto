/**
 * enrichCandidates (P2) — làm giàu top candidate bằng SOLD THẬT + rank Bestseller.
 *
 * RapidAPI search chỉ có review/rating → winScore chỉ là proxy. Bước này mở từng
 * candidate bằng Kiki (anti-detect), bắt BFF:
 *   - get_goods_detail_realtime_data → last90DaysSoldNum (sold 90 ngày thật)
 *   - get_detail_rank_info           → "No.X Bestseller" (best-effort)
 * rồi RE-SCORE winScore (ưu tiên sold) + opportunityScore, ghi đè DB.
 *
 * 1 phiên Kiki cho cả lô (mở/đóng page từng sp) → tiết kiệm start/stop.
 */
import { chromium } from "playwright-core";
import { kiki } from "../../services/kiki/client";
import { attachStatsCapture, attachRankCapture } from "../../services/kiki/productStats";
import { ensureNoCaptcha, type CaptchaOptions } from "../../services/kiki/captcha";
import { scoreWin } from "../winScore";
import { scoreOpportunity } from "./opportunityScore";
import { researchStore, today, type Candidate } from "../../state/researchStore";

export interface EnrichParams {
  profileId: string;
  day?: string;
  limit?: number;
  country?: string;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
}

export interface EnrichItemResult {
  id: string;
  goodsId: string;
  ok: boolean;
  soldText?: string | null;
  soldNum?: number | null;
  rankText?: string | null;
  winBefore?: number;
  winAfter?: number;
  oppBefore?: number;
  oppAfter?: number;
  error?: string;
}

export interface EnrichResult {
  day: string;
  enriched: number;
  withSold: number;
  results: EnrichItemResult[];
}

export async function enrichCandidates(params: EnrichParams): Promise<EnrichResult> {
  const day = params.day ?? today();
  const limit = Math.min(40, params.limit ?? 20);
  const log = params.onLog ?? (() => {});
  const profileId = params.profileId;

  const candidates = researchStore.listUnenriched(day, limit);
  if (!candidates.length) {
    log("Không có candidate cần làm giàu (đã enrich hết hoặc chưa có).");
    return { day, enriched: 0, withSold: 0, results: [] };
  }

  // nicheHeat theo ngách (để re-score opportunity)
  const heatMap = new Map(researchStore.listNiches(day).map((n) => [n.nicheKey, n.heatScore]));

  log(`Force-stop profile ${profileId}…`);
  await kiki.forceStop(profileId);
  log(`Khởi động Kiki profile…`);
  const started = await kiki.startWithRetry(profileId, log);
  log(`Kết nối CDP (port ${started.debuggingPort})…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const results: EnrichItemResult[] = [];
  let withSold = 0;

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());

    // Warm-up homepage 1 lần cho "giống người"
    try {
      const warm = await ctx.newPage();
      await warm.goto("https://us.shein.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await warm.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
      await warm.close();
    } catch { /* bỏ qua warm-up lỗi */ }

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const r: EnrichItemResult = { id: c.id, goodsId: c.goodsId, ok: false, winBefore: c.winScore, oppBefore: c.opportunityScore };
      if (!c.url) { r.error = "thiếu URL"; results.push(r); continue; }

      let page: any;
      try {
        page = await ctx.newPage();
        const goodsId = c.url.match(/-p-(\d+)\.html/)?.[1] ?? c.goodsId;
        const statsCap = attachStatsCapture(page, goodsId);
        const rankCap = attachRankCapture(page);

        log(`(${i + 1}/${candidates.length}) Mở ${c.goodsId}…`);
        await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2500);
        await ensureNoCaptcha(page, { ...params.captcha, onLog: log, context: `Enrich ${c.goodsId}`, profileId });
        // chờ BFF realtime/rank kịp về
        await page.waitForTimeout(2000);
        statsCap.detach();
        rankCap.detach();

        const soldNum = statsCap.stats.soldNum;
        const soldText = statsCap.stats.soldText;
        const rankText = rankCap.rank.bannerText
          ? `${rankCap.rank.bannerText}${rankCap.rank.nicheText ? " " + rankCap.rank.nicheText : ""}`
          : null;

        // Re-score với sold thật
        const snap = researchStore.findProduct(day, c.goodsId);
        const win = scoreWin({
          goodsId: c.goodsId,
          goodsSn: "",
          name: c.name,
          image: c.image,
          url: c.url,
          price: c.price ?? snap?.price ?? null,
          retailPrice: snap?.retailPrice ?? null,
          discountPct: snap?.discountPct ?? null,
          commentNum: Math.max(c.commentNum, statsCap.stats.reviewCount ?? 0),
          rating: statsCap.stats.rating ?? c.rating ?? snap?.rating ?? null,
          labels: [],
          source: "shein-data-api",
          soldNum,
        });
        const nicheHeat = heatMap.get(c.nicheKey) ?? 0;
        const opp = scoreOpportunity({ win, nicheHeat });

        researchStore.applyEnrichment({
          day,
          goodsId: c.goodsId,
          candidateId: c.id,
          soldNum,
          soldText,
          rankText,
          winScore: win.winScore,
          winTier: win.winTier,
          opportunityScore: opp.opportunityScore,
        });

        if (soldNum && soldNum > 0) withSold++;
        Object.assign(r, {
          ok: true,
          soldText,
          soldNum,
          rankText,
          winAfter: win.winScore,
          oppAfter: opp.opportunityScore,
        });
        log(`   ✓ sold ${soldText ?? "?"} · win ${c.winScore}→${win.winScore} · opp ${c.opportunityScore}→${opp.opportunityScore}${rankText ? " · " + rankText : ""}`);
      } catch (e: any) {
        r.error = e?.message ?? String(e);
        log(`   ✗ ${c.goodsId}: ${r.error}`);
      } finally {
        try { if (page) await page.close(); } catch { /* ignore */ }
      }
      results.push(r);
      // nhịp người giữa các sp
      await new Promise((res) => setTimeout(res, 1500 + Math.floor(Math.random() * 2000)));
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile.`);
  }

  const enriched = results.filter((r) => r.ok).length;
  log(`✅ Enrich xong: ${enriched}/${candidates.length} sp · ${withSold} có sold thật.`);
  return { day, enriched, withSold, results };
}
