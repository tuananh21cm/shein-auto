/**
 * validateCandidates (Deep Validation Gate) — GỘP enrich + kiểm định sâu.
 *
 * 1 phiên Kiki, mỗi candidate: mở detail → bắt sold/rating/rank + ship-local/inter +
 * size/material/ugc + true-to-size (BFF, scroll để load review, DOM fallback) →
 * re-score win/opp → chấm verdict PASS/WATCH/REJECT → lưu.
 *
 * Thay thế enrichCandidates: vừa làm giàu sold/rank vừa ra verdict.
 */
import { chromium } from "playwright-core";
import { kiki } from "../../services/kiki/client";
import { attachStatsCapture, attachRankCapture } from "../../services/kiki/productStats";
import { attachDetailCapture, readTrueToSizeDom } from "../../services/kiki/detailSignals";
import { ensureNoCaptcha, type CaptchaOptions } from "../../services/kiki/captcha";
import { scoreWin } from "../winScore";
import { scoreOpportunity } from "./opportunityScore";
import { validateProduct } from "./validateProduct";
import { researchStore, today } from "../../state/researchStore";

export interface ValidateParams {
  profileId: string;
  day?: string;
  limit?: number;
  niche?: string;          // chỉ validate sp 1 ngách (Soi ngách)
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
}

export interface ValidateItemResult {
  id: string;
  goodsId: string;
  ok: boolean;
  verdict?: string;
  validationScore?: number;
  soldText?: string | null;
  isLocal?: boolean | null;
  trueToSize?: number | null;
  error?: string;
}

export interface ValidateResult {
  day: string;
  validated: number;
  pass: number;
  watch: number;
  reject: number;
  results: ValidateItemResult[];
}

async function loadReviews(page: any): Promise<void> {
  // SHEIN lazy-load review/buyer-show khi scroll → cuộn vài nhịp.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1400 + Math.floor(Math.random() * 600)).catch(() => {});
    await page.waitForTimeout(900 + Math.floor(Math.random() * 700));
  }
}

export async function validateCandidates(params: ValidateParams): Promise<ValidateResult> {
  const day = params.day ?? today();
  const limit = Math.min(40, params.limit ?? 20);
  const log = params.onLog ?? (() => {});
  const profileId = params.profileId;

  const candidates = researchStore.listUnvalidated(day, limit, params.niche);
  if (!candidates.length) {
    log("Không có candidate cần kiểm định (đã validate hết hoặc chưa có).");
    return { day, validated: 0, pass: 0, watch: 0, reject: 0, results: [] };
  }

  const heatMap = new Map(researchStore.listNiches(day).map((n) => [n.nicheKey, n.heatScore]));

  log(`Force-stop profile ${profileId}…`);
  await kiki.forceStop(profileId);
  log(`Khởi động Kiki profile…`);
  const started = await kiki.startWithRetry(profileId, log);
  log(`Kết nối CDP (port ${started.debuggingPort})…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const results: ValidateItemResult[] = [];
  let pass = 0, watch = 0, reject = 0;

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    try {
      const warm = await ctx.newPage();
      await warm.goto("https://us.shein.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await warm.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
      await warm.close();
    } catch { /* warm-up best-effort */ }

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const r: ValidateItemResult = { id: c.id, goodsId: c.goodsId, ok: false };
      if (!c.url) { r.error = "thiếu URL"; results.push(r); continue; }

      let page: any;
      try {
        page = await ctx.newPage();
        const goodsId = c.url.match(/-p-(\d+)\.html/)?.[1] ?? c.goodsId;
        const statsCap = attachStatsCapture(page, goodsId);
        const rankCap = attachRankCapture(page);
        const detailCap = attachDetailCapture(page);

        log(`(${i + 1}/${candidates.length}) Mở ${c.goodsId}…`);
        await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2500);
        await ensureNoCaptcha(page, { ...params.captcha, onLog: log, context: `Validate ${c.goodsId}`, profileId });
        await loadReviews(page); // kéo review/buyer-show về
        await page.waitForTimeout(1500);

        // DOM fallback true-to-size nếu BFF chưa có
        if (detailCap.signals.trueToSize == null) {
          const dom = await readTrueToSizeDom(page);
          if (dom != null) detailCap.signals.trueToSize = dom;
        }
        statsCap.detach(); rankCap.detach(); detailCap.detach();

        const stats = statsCap.stats;
        const snap = researchStore.findProduct(day, c.goodsId);
        const rating = stats.rating ?? c.rating ?? snap?.rating ?? null;

        // Re-score win/opp với sold thật (giống enrich)
        const win = scoreWin({
          goodsId: c.goodsId, goodsSn: "", name: c.name, image: c.image, url: c.url,
          price: c.price ?? snap?.price ?? null, retailPrice: snap?.retailPrice ?? null,
          discountPct: snap?.discountPct ?? null,
          commentNum: Math.max(c.commentNum, stats.reviewCount ?? 0),
          rating, labels: [], source: "shein-data-api", soldNum: stats.soldNum,
        });
        const opp = scoreOpportunity({ win, nicheHeat: heatMap.get(c.nicheKey) ?? 0 });
        const rankText = rankCap.rank.bannerText
          ? `${rankCap.rank.bannerText}${rankCap.rank.nicheText ? " " + rankCap.rank.nicheText : ""}`
          : null;
        researchStore.applyEnrichment({
          day, goodsId: c.goodsId, candidateId: c.id,
          soldNum: stats.soldNum, soldText: stats.soldText, rankText,
          winScore: win.winScore, winTier: win.winTier, opportunityScore: opp.opportunityScore,
        });

        // Kiểm định
        const val = validateProduct({
          name: c.name, rating, fiveStarPct: stats.fiveStarPct,
          soldNum: stats.soldNum, discountPct: snap?.discountPct ?? null,
          signals: detailCap.signals,
        });
        researchStore.applyValidation(c.id, {
          validationScore: val.validationScore, verdict: val.verdict, isLocal: val.isLocal,
          shipMode: val.shipMode, shipDays: val.shipDays, trueToSize: val.trueToSize,
          ugcCount: val.ugcCount, ipRisk: val.ipRisk,
          validationJson: JSON.stringify({ badges: val.badges, breakdown: val.breakdown, reasons: val.reasons }),
        });

        if (val.verdict === "PASS") pass++;
        else if (val.verdict === "WATCH") watch++;
        else reject++;
        Object.assign(r, {
          ok: true, verdict: val.verdict, validationScore: val.validationScore,
          soldText: stats.soldText, isLocal: val.isLocal, trueToSize: val.trueToSize,
        });
        log(`   ${val.verdict === "PASS" ? "✅" : val.verdict === "WATCH" ? "🟡" : "❌"} ${val.verdict} ${val.validationScore} · ${val.badges.join(" ")}${val.reasons.length ? " · " + val.reasons.join("; ") : ""}`);
      } catch (e: any) {
        r.error = e?.message ?? String(e);
        log(`   ✗ ${c.goodsId}: ${r.error}`);
      } finally {
        try { if (page) await page.close(); } catch { /* ignore */ }
      }
      results.push(r);
      await new Promise((res) => setTimeout(res, 1500 + Math.floor(Math.random() * 2000)));
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile.`);
  }

  log(`✅ Validate xong: ${pass} PASS · ${watch} WATCH · ${reject} REJECT (/${candidates.length}).`);
  return { day, validated: results.filter((r) => r.ok).length, pass, watch, reject, results };
}
