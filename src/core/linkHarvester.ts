/**
 * linkHarvester — TỰ ĐỘNG kéo link SHEIN về hàng đợi uncrawl (shop_allocation) theo NGÁCH shop.
 *
 * Mỗi cycle: với shop có uncrawl < threshold → mỗi ngách:
 *   1) RapidAPI: pullMoreForShop (nguồn sẵn có).
 *   2) Chrome: Gemini sinh bộ keyword tương tự ngách → search SHEIN qua Chrome (crawlStore) →
 *      chấm điểm (winScore→opportunityScore) → chèn sp đạt ngưỡng vào shop_allocation.
 * Tự bật Chrome (ensureChromeDebug). Chạy nền, poll theo interval.
 */
import { getDb } from "../state/db";
import { scoreWin, type WinScored } from "./winScore";
import { rollupNiche } from "./research/nicheScore";
import { matchNicheDemand } from "./research/demandFit";
import { scoreOpportunity } from "./research/opportunityScore";
import { pullMoreForShop } from "./research/pullMoreData";
import { isKidsProduct } from "./research/fashionFilter";
import { harvestKeywordsViaChrome } from "./research/harvestViaChrome";
import { expandNicheKeywords } from "../services/gemini/expandKeywords";
import { researchConfig, harvestConfig } from "../config/appConfig";
import { kalodataStore } from "../state/kalodataStore";
import type { StoreProduct } from "../services/kiki/storeCrawler";

function toSheinProduct(p: StoreProduct): any {
  return {
    goodsId: p.goodsId, name: p.name ?? "", image: p.image ?? "", url: p.url ?? "",
    price: p.price, retailPrice: p.retailPrice, discountPct: p.discountPct,
    commentNum: p.reviewCount ?? 0, rating: p.rating ?? null,
  };
}

/** Chấm điểm + insert list StoreProduct (từ Chrome) vào shop_allocation cho (shop, niche). */
function scoreAndInsertStore(
  shop: string, nicheKey: string, query: string, group: string,
  products: StoreProduct[], minOpp: number, kaloCats: any[], log: (m: string) => void
): number {
  const db = getDb();
  const cfg = researchConfig();
  const capCfg = cfg.maxShopsPerProduct;
  const capN = typeof capCfg === "number" && capCfg > 0 ? capCfg : Infinity;

  const existingForShop = new Set(
    (db.prepare("SELECT goods_id FROM shop_allocation WHERE shop=?").all(shop) as any[]).map((r) => String(r.goods_id))
  );
  const excluded = new Set(
    (db.prepare("SELECT goods_id FROM excluded_products").all() as any[]).map((r) => String(r.goods_id))
  );
  const shopCountByGid = new Map<string, number>();
  for (const r of db.prepare("SELECT goods_id, COUNT(DISTINCT shop) n FROM shop_allocation GROUP BY goods_id").all() as any[])
    shopCountByGid.set(String(r.goods_id), Number(r.n) || 0);

  let kidsSkipped = 0;
  const fresh = products.filter((p) => {
    const gid = String(p.goodsId);
    if (!/^\d{5,}$/.test(gid) || existingForShop.has(gid) || excluded.has(gid) || (shopCountByGid.get(gid) || 0) >= capN) return false;
    if (isKidsProduct(p.name, p.catName)) { kidsSkipped++; return false; } // loại hàng trẻ em
    return true;
  });
  if (kidsSkipped) log(`   [Chrome] bỏ ${kidsSkipped} sp trẻ em`);
  const wins: WinScored[] = fresh.map((p) => scoreWin(toSheinProduct(p)));
  const rollup = rollupNiche(wins);
  const dm = matchNicheDemand({ key: nicheKey, group, query } as any, kaloCats);
  const scored = wins
    .map((w) => ({ w, opp: scoreOpportunity({ win: w, nicheHeat: rollup.heatScore, demandFit: dm.demandFit }).opportunityScore }))
    .filter((x) => x.opp >= minOpp)
    .sort((a, b) => b.opp - a.opp);

  const ins = db.prepare(
    `INSERT OR IGNORE INTO shop_allocation
       (goods_id, shop, niche_key, name, win_score, opportunity_score, price, url, image, status, allocated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocated', ?)`
  );
  const now = Date.now();
  let inserted = 0;
  for (const { w, opp } of scored) {
    const gid = String(w.goodsId);
    const info = ins.run(
      gid, shop, nicheKey, w.name ?? "", Math.round(w.winScore), Math.round(opp),
      w.price ?? null, w.url || `https://us.shein.com/-p-${gid}.html`, w.image ?? "", now
    );
    if (info.changes > 0) inserted++;
  }
  log(`   [Chrome] ${fresh.length} mới · ${scored.length} đạt điểm (≥${minOpp}) · ${inserted} nạp`);
  return inserted;
}

export interface HarvestCycleResult { shops: number; inserted: number; perShop: Record<string, number> }

export async function runHarvestCycle(
  opts: { onLog?: (m: string) => void; maxShops?: number; onlyShops?: string[] } = {}
): Promise<HarvestCycleResult> {
  const log = opts.onLog ?? (() => {});
  const db = getDb();
  const cfg = harvestConfig();
  const rcfg = researchConfig();
  const minOpp = rcfg.candidate?.minOpportunity ?? 55;
  const kaloDay = kalodataStore.latestDay();
  const kaloCats = kaloDay ? kalodataStore.listCategories(kaloDay) : [];

  const rows = db.prepare(
    `SELECT sn.shop shop, sn.niche_key niche,
       (SELECT COUNT(*) FROM shop_allocation sa WHERE sa.shop=sn.shop AND sa.status IN ('allocated','recrawl')) uncrawl
     FROM shop_niche sn WHERE sn.status != 'paused'`
  ).all() as any[];
  const byShop: Record<string, string[]> = {};
  const uncrawlByShop: Record<string, number> = {};
  for (const r of rows) { (byShop[r.shop] ??= []).push(r.niche); uncrawlByShop[r.shop] = r.uncrawl; }
  let targets = Object.keys(byShop).filter((s) => (uncrawlByShop[s] ?? 0) < cfg.threshold);
  if (opts.onlyShops?.length) targets = targets.filter((s) => opts.onlyShops!.includes(s));
  if (opts.maxShops && opts.maxShops > 0) targets = targets.slice(0, opts.maxShops);

  if (!targets.length) { log(`(không có shop cần harvest)`); return { shops: 0, inserted: 0, perShop: {} }; }

  const perShop: Record<string, number> = {};
  let totalInserted = 0;
  for (const shop of targets) {
    const before = totalInserted;
    log(`\n🛒 [${shop}] uncrawl=${uncrawlByShop[shop]} < ${cfg.threshold} → harvest`);
    for (const niche of byShop[shop]) {
      const ncfg = rcfg.niches?.find((n) => n.key === niche);
      const query = ncfg?.query || niche.replace(/-/g, " ");
      const group = ncfg?.group || "";
      // 1) RapidAPI
      try {
        const r = await pullMoreForShop({ shop, nicheKey: niche, onLog: (m) => log("   " + m) });
        totalInserted += r.totalInserted;
      } catch (e: any) { log(`   ⚠️ RapidAPI [${niche}] lỗi: ${String(e?.message ?? e).slice(0, 60)}`); }
      // 2) Chrome + Gemini keyword
      if (cfg.useChrome) {
        try {
          const kws = await expandNicheKeywords(niche, query, cfg.keywordsPerNiche);
          log(`   [Chrome] ${kws.length} keyword: ${kws.slice(0, 5).join(", ")}${kws.length > 5 ? "…" : ""}`);
          const prods = await harvestKeywordsViaChrome(kws, {
            cdpUrl: cfg.cdpUrl, maxPerKeyword: cfg.resultsPerKeyword, onLog: (m) => log("   " + m),
          });
          totalInserted += scoreAndInsertStore(shop, niche, query, group, prods, minOpp, kaloCats, log);
        } catch (e: any) { log(`   ⚠️ Chrome [${niche}] lỗi: ${String(e?.message ?? e).slice(0, 80)}`); }
      }
    }
    perShop[shop] = totalInserted - before;
  }
  return { shops: targets.length, inserted: totalInserted, perShop };
}

/* ============= Background scheduler ============= */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function scheduleHarvester(): void {
  const cfg = harvestConfig();
  if (!cfg.enabled) { console.log("⏰ Link-harvester: TẮT (harvest.json → enabled=false)"); return; }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      console.log("[harvest] ▶ cycle bắt đầu…");
      const r = await runHarvestCycle({ onLog: (m) => console.log("[harvest]", m) });
      console.log(`[harvest] cycle xong: ${r.shops} shop · nạp ${r.inserted} link uncrawl`);
    } catch (e: any) {
      console.error("[harvest] ✗ lỗi:", e?.message ?? e);
    }
    running = false;
    timer = setTimeout(tick, cfg.intervalMinutes * 60_000);
  };
  timer = setTimeout(tick, 10_000);
  console.log(`⏰ Link-harvester: BẬT (uncrawl < ${cfg.threshold} → harvest · mỗi ${cfg.intervalMinutes}p · Chrome ${cfg.useChrome})`);
}

export function stopHarvester(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
