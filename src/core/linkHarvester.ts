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
import { isKidsProduct, isPackProduct } from "./research/fashionFilter";
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

/** Chấm điểm + insert list StoreProduct (từ Chrome) vào shop_allocation cho (shop, niche).
 *  maxPrice: chỉ nạp sp giá < ngưỡng (Infinity = không lọc). limit: trần số insert lần này.
 *  dbArg: cho phép inject DB (test). Mặc định dùng DB thật (getDb). Export để unit-test lọc giá/cap. */
export function scoreAndInsertStore(
  shop: string, nicheKey: string, query: string, group: string,
  products: StoreProduct[], minOpp: number, kaloCats: any[], log: (m: string) => void,
  maxPrice: number = Infinity, limit: number = Infinity,
  dbArg?: any
): number {
  const db = dbArg ?? getDb();
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

  // Giá không rõ (null) khi đang giới hạn giá → LOẠI (không đảm bảo < ngưỡng).
  const priceOk = (p: number | null | undefined): boolean =>
    maxPrice === Infinity ? true : typeof p === "number" && p < maxPrice;

  let kidsSkipped = 0, priceSkipped = 0, packSkipped = 0;
  const fresh = products.filter((p) => {
    const gid = String(p.goodsId);
    if (!/^\d{5,}$/.test(gid) || existingForShop.has(gid) || excluded.has(gid) || (shopCountByGid.get(gid) || 0) >= capN) return false;
    if (isKidsProduct(p.name, p.catName)) { kidsSkipped++; return false; } // loại hàng trẻ em
    if (isPackProduct(p.name)) { packSkipped++; return false; }               // loại hàng pack (2-3pcs…)
    if (!priceOk(p.price)) { priceSkipped++; return false; }               // loại sp giá >= ngưỡng
    return true;
  });
  if (kidsSkipped) log(`   [Chrome] bỏ ${kidsSkipped} sp trẻ em`);
  if (packSkipped) log(`   [Chrome] bỏ ${packSkipped} sp pack (2-3pcs…)`);
  if (priceSkipped) log(`   [Chrome] bỏ ${priceSkipped} sp giá ≥ $${maxPrice}`);
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
    if (inserted >= limit) break; // đủ trần (mục tiêu/shop) → dừng
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

  // Mục tiêu listing/shop + giới hạn giá (từ config).
  const target = cfg.targetListingsPerShop > 0 ? cfg.targetListingsPerShop : 100;
  const maxPrice = typeof cfg.maxPriceUsd === "number" && cfg.maxPriceUsd > 0 ? cfg.maxPriceUsd : Infinity;

  // kept = sp ĐÃ/SẼ thành listing (allocated+recrawl+crawled+listed) — KHÔNG tính failed/excluded.
  // Shop đạt kept >= target thì DỪNG harvest. Shop chưa gắn ngách → không có trong shop_niche → tự bỏ.
  const rows = db.prepare(
    `SELECT sn.shop shop, sn.niche_key niche,
       (SELECT COUNT(*) FROM shop_allocation sa WHERE sa.shop=sn.shop
          AND sa.status IN ('allocated','recrawl','crawled','listed')) kept
     FROM shop_niche sn WHERE sn.status != 'paused'`
  ).all() as any[];
  const byShop: Record<string, string[]> = {};
  const keptByShop: Record<string, number> = {};
  for (const r of rows) { (byShop[r.shop] ??= []).push(r.niche); keptByShop[r.shop] = r.kept; }
  let targets = Object.keys(byShop).filter((s) => (keptByShop[s] ?? 0) < target);
  if (opts.onlyShops?.length) targets = targets.filter((s) => opts.onlyShops!.includes(s));
  if (opts.maxShops && opts.maxShops > 0) targets = targets.slice(0, opts.maxShops);

  if (!targets.length) { log(`(mọi shop đã đủ ${target} listing — không harvest)`); return { shops: 0, inserted: 0, perShop: {} }; }

  const perShop: Record<string, number> = {};
  let totalInserted = 0;
  for (const shop of targets) {
    const before = totalInserted;
    let remaining = target - (keptByShop[shop] ?? 0); // trần nạp cho shop này (không vượt mục tiêu)
    log(`\n🛒 [${shop}] ${keptByShop[shop]}/${target} listing → harvest thêm ${remaining}${maxPrice !== Infinity ? ` (giá < $${maxPrice})` : ""}`);
    for (const niche of byShop[shop]) {
      if (remaining <= 0) break; // đủ mục tiêu shop → dừng các ngách còn lại
      const ncfg = rcfg.niches?.find((n) => n.key === niche);
      const query = ncfg?.query || niche.replace(/-/g, " ");
      const group = ncfg?.group || "";
      // 1) RapidAPI
      try {
        const r = await pullMoreForShop({ shop, nicheKey: niche, maxPriceUsd: maxPrice === Infinity ? undefined : maxPrice, maxInsert: remaining, onLog: (m) => log("   " + m) });
        totalInserted += r.totalInserted; remaining -= r.totalInserted;
      } catch (e: any) { log(`   ⚠️ RapidAPI [${niche}] lỗi: ${String(e?.message ?? e).slice(0, 60)}`); }
      if (remaining <= 0) break;
      // 2) Chrome + Gemini keyword
      if (cfg.useChrome) {
        try {
          const kws = await expandNicheKeywords(niche, query, cfg.keywordsPerNiche);
          log(`   [Chrome] ${kws.length} keyword: ${kws.slice(0, 5).join(", ")}${kws.length > 5 ? "…" : ""}`);
          const prods = await harvestKeywordsViaChrome(kws, {
            cdpUrl: cfg.cdpUrl, maxPerKeyword: cfg.resultsPerKeyword, onLog: (m) => log("   " + m),
          });
          const ins = scoreAndInsertStore(shop, niche, query, group, prods, minOpp, kaloCats, log, maxPrice, remaining);
          totalInserted += ins; remaining -= ins;
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
  const priceNote = typeof cfg.maxPriceUsd === "number" && cfg.maxPriceUsd > 0 ? ` · giá < $${cfg.maxPriceUsd}` : "";
  console.log(`⏰ Link-harvester: BẬT (mục tiêu ${cfg.targetListingsPerShop} listing/shop${priceNote} · mỗi ${cfg.intervalMinutes}p · Chrome ${cfg.useChrome})`);
}

export function stopHarvester(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
