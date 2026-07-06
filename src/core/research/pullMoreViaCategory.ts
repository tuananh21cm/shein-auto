/**
 * pullMoreViaCategory — nạp hàng đợi uncrawl (shop_allocation) từ API GỐC SHEIN
 * (get_select_product_list) qua Chrome CDP, thay cho nguồn RapidAPI của pullMoreData.
 *
 * Vì sao dùng nguồn này:
 *   - Field giàu hơn RapidAPI: true-to-size, isHighestSales/isLowestPrice, rating, stock
 *     → winScore + lọc chuẩn hơn.
 *   - Ngách-native (select_id) = đúng cây "RecommendSelection" SHEIN tự curate → sp bán được
 *     thật, ít nhiễu hơn keyword search.
 *
 * Giống pullMoreData: dedup toàn cục (shop_allocation + excluded_products), CHẤM ĐIỂM đúng
 * chuỗi research (winScore → rollupNiche → demandFit → opportunityScore), chỉ nạp sp
 * opportunityScore >= minOpportunity vào status='allocated'.
 *
 * Anti-bot: harvestCategoryProducts để CHÍNH TRANG tự gọi API (header SDK hợp lệ), cuộn
 * người-hoá, gặp captcha thì dừng ngách đó và đi tiếp. Giãn cách interNicheDelayMs giữa ngách.
 */
import { getDb } from "../../state/db";
import { harvestCategoryProducts } from "../../services/shein/categoryClient";
import { scoreWin, type WinScored } from "../winScore";
import { rollupNiche } from "./nicheScore";
import { matchNicheDemand } from "./demandFit";
import { scoreOpportunity } from "./opportunityScore";
import { researchConfig, categoryCrawlConfig } from "../../config/appConfig";
import { kalodataStore } from "../../state/kalodataStore";

export interface PullCategoryOpts {
  shop: string;
  /** Chỉ kéo ngách này (phải có selectId trong research.json). Không → mọi ngách gán shop có selectId. */
  nicheKey?: string;
  /** Override selectId/URL trực tiếp (ad-hoc, bỏ qua research.json). Cần kèm nicheKey để gán. */
  selectId?: string;
  /** Override cat_id trực tiếp (ad-hoc). Ưu tiên hơn selectId. */
  catId?: string;
  maxProducts?: number;
  maxScrolls?: number;
  minOpportunity?: number;
  /** >0 = chờ người giải captcha tay (ms) thay vì dừng. Dùng khi test tay. */
  captchaWaitMs?: number;
  dryRun?: boolean;
  onLog?: (m: string) => void;
}

export interface PullCategoryNiche {
  nicheKey: string;
  selectId: string;
  harvested: number;   // sp gom được từ trang
  total: number | null; // tổng sp ngách (field num)
  fresh: number;       // sau loại đã có / excluded
  passed: number;      // qua ngưỡng điểm
  inserted: number;
  heatScore: number;
  demandFit: number;
  captcha: boolean;
}

export interface PullCategoryResult {
  shop: string;
  niches: PullCategoryNiche[];
  totalInserted: number;
  minOpportunity: number;
  samples: { goodsId: string; name: string; opportunityScore: number; winScore: number; price: number | null }[];
}

export async function pullCategoryForShop(opts: PullCategoryOpts): Promise<PullCategoryResult> {
  const log = opts.onLog ?? (() => {});
  const db = getDb();
  const cfg = researchConfig();
  const ccfg = categoryCrawlConfig();
  const maxProducts = opts.maxProducts ?? ccfg.maxProductsPerNiche ?? 120;
  const maxScrolls = opts.maxScrolls ?? ccfg.maxScrolls ?? 0;
  const minOpp = opts.minOpportunity ?? ccfg.minOpportunity ?? cfg.candidate?.minOpportunity ?? 55;

  // 1. Ngách cần cào → {nicheKey, selectId?|catId?}. Ad-hoc override có ưu tiên. catId > selectId.
  type Target = { nicheKey: string; selectId?: string; catId?: string; group: string; query: string };
  const targets: Target[] = [];
  if (opts.catId || opts.selectId) {
    const nicheKey = opts.nicheKey || `adhoc-${opts.catId || opts.selectId}`.slice(0, 40);
    const ncfg = cfg.niches.find((n) => n.key === nicheKey);
    targets.push({ nicheKey, selectId: opts.selectId, catId: opts.catId, group: ncfg?.group || "", query: ncfg?.query || nicheKey });
  } else {
    const wantKeys: string[] = opts.nicheKey
      ? [opts.nicheKey]
      : (db.prepare("SELECT niche_key FROM shop_niche WHERE shop=?").all(opts.shop) as any[])
          .map((r) => r.niche_key)
          .filter(Boolean);
    for (const key of wantKeys) {
      const ncfg = cfg.niches.find((n) => n.key === key);
      if (!ncfg?.selectId && !ncfg?.catId) { log(`   ⏭️ Ngách "${key}" chưa có selectId/catId → bỏ (thêm vào research.json để cào).`); continue; }
      targets.push({ nicheKey: key, selectId: ncfg.selectId, catId: ncfg.catId, group: ncfg.group || "", query: ncfg.query || key });
    }
  }
  if (!targets.length) throw new Error(`Không có ngách nào có selectId/catId để cào cho shop "${opts.shop}".`);

  // 2. Demand Kalodata (demandFit). Rỗng → fallback 50.
  const kaloDay = kalodataStore.latestDay();
  const kaloCats = kaloDay ? kalodataStore.listCategories(kaloDay) : [];

  // 3. Dedup PER-SHOP + cap số shop/sp (1 sp list được nhiều shop, tối đa cap).
  const capCfg = cfg.maxShopsPerProduct;
  const capN = typeof capCfg === "number" && capCfg > 0 ? capCfg : Infinity;
  const existingForShop = new Set<string>(
    (db.prepare("SELECT goods_id FROM shop_allocation WHERE shop=?").all(opts.shop) as any[]).map((r) => String(r.goods_id))
  );
  const shopCountByGid = new Map<string, number>();
  for (const r of db.prepare("SELECT goods_id, COUNT(DISTINCT shop) n FROM shop_allocation GROUP BY goods_id").all() as any[]) {
    shopCountByGid.set(String(r.goods_id), Number(r.n) || 0);
  }
  const excluded = new Set<string>(
    (db.prepare("SELECT goods_id FROM excluded_products").all() as any[]).map((r) => String(r.goods_id))
  );

  const ins = db.prepare(
    `INSERT OR IGNORE INTO shop_allocation
       (goods_id, shop, niche_key, name, win_score, opportunity_score, price, url, image, status, allocated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocated', ?)`
  );

  const niches: PullCategoryNiche[] = [];
  const samples: PullCategoryResult["samples"] = [];
  let totalInserted = 0;

  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    // 3a. Cào list ngách (site tự gọi API).
    const harvest = await harvestCategoryProducts({
      selectId: t.selectId,
      catId: t.catId,
      cdpUrl: ccfg.cdpUrl,
      maxProducts,
      maxScrolls,
      captchaWaitMs: opts.captchaWaitMs,
      onLog: log,
    });

    // 3b. Loại: đã có CHO SHOP NÀY / excluded / đã đạt cap số shop.
    const fresh = harvest.products.filter((p) => {
      const gid = String(p.goodsId);
      if (existingForShop.has(gid) || excluded.has(gid)) return false;
      if ((shopCountByGid.get(gid) || 0) >= capN) return false;
      return true;
    });

    // 3c. Chấm điểm đúng chuỗi research.
    const wins: WinScored[] = fresh.map(scoreWin);
    const rollup = rollupNiche(wins);
    const dm = matchNicheDemand({ key: t.nicheKey, group: t.group, query: t.query } as any, kaloCats);

    const scored = wins
      .map((w) => {
        const opp = scoreOpportunity({ win: w, nicheHeat: rollup.heatScore, demandFit: dm.demandFit });
        return { w, opportunityScore: opp.opportunityScore };
      })
      .filter((x) => x.opportunityScore >= minOpp)
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    // 3d. Insert (trừ dry-run).
    let inserted = 0;
    const now = Date.now();
    for (const { w, opportunityScore } of scored) {
      const gid = String(w.goodsId);
      if (!opts.dryRun) {
        const info = ins.run(
          gid, opts.shop, t.nicheKey, w.name ?? "",
          Math.round(w.winScore), Math.round(opportunityScore),
          w.price ?? null,
          w.url || `https://us.shein.com/-p-${gid}.html`,
          w.image ?? "",
          now
        );
        if (info.changes > 0) { inserted++; shopCountByGid.set(gid, (shopCountByGid.get(gid) || 0) + 1); }
      }
      existingForShop.add(gid); // tránh insert lại cho SHOP NÀY trong phiên (ngách khác)
      if (samples.length < 8) {
        samples.push({ goodsId: gid, name: (w.name ?? "").slice(0, 60), opportunityScore: Math.round(opportunityScore), winScore: Math.round(w.winScore), price: w.price ?? null });
      }
    }
    totalInserted += inserted;

    niches.push({
      nicheKey: t.nicheKey, selectId: harvest.selectId,
      harvested: harvest.products.length, total: harvest.total,
      fresh: fresh.length, passed: scored.length, inserted,
      heatScore: rollup.heatScore, demandFit: dm.demandFit, captcha: harvest.captcha,
    });
    log(
      `   ✓ [${t.nicheKey}] gom ${harvest.products.length} · ${fresh.length} mới · ` +
      `${scored.length} đạt điểm (≥${minOpp}) · ${opts.dryRun ? "DRY-RUN" : inserted + " nạp"} · nhiệt ${rollup.heatScore}` +
      `${harvest.captcha ? " ⚠️captcha" : ""}`
    );

    // 3e. Giãn cách giữa ngách (trừ ngách cuối) — tránh dồn request kích risk 909.
    if (ti < targets.length - 1) await new Promise((r) => setTimeout(r, ccfg.interNicheDelayMs ?? 8000));
  }

  return { shop: opts.shop, niches, totalInserted, minOpportunity: minOpp, samples };
}
