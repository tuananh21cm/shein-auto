/**
 * pullMoreData — kéo thêm sản phẩm SHEIN từ RapidAPI cho 1 shop theo NGÁCH của shop,
 * LOẠI TRỪ data đã có (shop_allocation toàn cục + excluded_products), CHẤM ĐIỂM bằng
 * đúng công thức research (winScore → rollupNiche → demandFit → opportunityScore), rồi
 * chỉ đổ sp ĐẠT ngưỡng vào hàng đợi uncrawl (shop_allocation status='allocated').
 *
 * KHÔNG kéo bừa: sp phải opportunityScore >= minOpportunity mới được nạp.
 *
 * CHỐNG TRÙNG (v12): con trỏ phân trang theo ngách (niche_pull_cursor) → mỗi lần kéo
 * TIẾP trang kế thay vì luôn từ trang 1 (trước đây ~40% kéo về là data đã có). Hết trang
 * (hasNext=false) → vòng lại trang 1. Thêm nguồn phụ: recommendedProducts từ sp đã thắng
 * của shop → "sp tương tự winner", ít trùng với search keyword.
 */
import { getDb } from "../../state/db";
import { searchProducts, recommendedProducts } from "../../services/shein/client";
import { scoreWin, type WinScored } from "../winScore";
import { rollupNiche } from "./nicheScore";
import { isKidsProduct } from "./fashionFilter";
import { matchNicheDemand } from "./demandFit";
import { scoreOpportunity } from "./opportunityScore";
import { researchConfig } from "../../config/appConfig";
import { kalodataStore } from "../../state/kalodataStore";

export interface PullMoreOpts {
  shop: string;
  nicheKey?: string;         // nếu truyền → chỉ kéo ngách này; không → mọi ngách gán cho shop
  pages?: number;            // số trang search MỖI LẦN kéo (tiếp từ con trỏ). Default 3
  perPage?: number;          // sp/trang. Default = research.perNichePerPage (40), tối đa 60
  minOpportunity?: number;   // ngưỡng điểm. Default = research.candidate.minOpportunity (55)
  resetCursor?: boolean;     // true = kéo lại từ trang 1 (bỏ con trỏ)
  useRecommended?: boolean;  // true (default) = thêm nguồn recommendedProducts từ winner của shop
  dryRun?: boolean;          // chấm + báo cáo nhưng KHÔNG insert
  onLog?: (m: string) => void;
}

export interface PullMoreNiche {
  nicheKey: string;
  query: string;
  pageFrom: number;   // trang bắt đầu (từ con trỏ)
  pageTo: number;     // trang kết thúc lần này
  searched: number;   // sp API trả về (sau dedupe trong batch)
  fresh: number;      // sau khi loại đã có / excluded
  passed: number;     // qua ngưỡng điểm
  inserted: number;   // thực sự insert (INSERT OR IGNORE)
  recommended: number; // sp fresh lấy thêm từ nguồn recommended
  heatScore: number;
  demandFit: number;
}

export interface PullMoreResult {
  shop: string;
  niches: PullMoreNiche[];
  totalInserted: number;
  minOpportunity: number;
  samples: { goodsId: string; name: string; opportunityScore: number; winScore: number; price: number | null }[];
}

/** Đọc con trỏ trang của ngách. exhausted → coi như bắt đầu lại từ trang 1. */
function readCursor(db: any, nicheKey: string, reset: boolean): number {
  if (reset) return 0;
  const row = db.prepare("SELECT last_page, exhausted FROM niche_pull_cursor WHERE niche_key=?").get(nicheKey) as any;
  if (!row || row.exhausted) return 0;
  return row.last_page || 0;
}
function writeCursor(db: any, nicheKey: string, lastPage: number, exhausted: boolean): void {
  db.prepare(
    `INSERT INTO niche_pull_cursor (niche_key, last_page, exhausted, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(niche_key) DO UPDATE SET last_page=excluded.last_page, exhausted=excluded.exhausted, updated_at=excluded.updated_at`
  ).run(nicheKey, lastPage, exhausted ? 1 : 0, Date.now());
}

export async function pullMoreForShop(opts: PullMoreOpts): Promise<PullMoreResult> {
  const log = opts.onLog ?? (() => {});
  const db = getDb();
  const cfg = researchConfig();
  const pages = Math.min(Math.max(opts.pages ?? 3, 1), 10); // mỗi lần kéo tối đa 10 trang
  const perPage = Math.min(Math.max(opts.perPage ?? cfg.perNichePerPage ?? 40, 10), 60);
  const minOpp = opts.minOpportunity ?? cfg.candidate?.minOpportunity ?? 55;
  const useRecommended = opts.useRecommended !== false;

  // 1. Ngách của shop
  let nicheKeys: string[];
  if (opts.nicheKey) {
    nicheKeys = [opts.nicheKey];
  } else {
    nicheKeys = (db.prepare("SELECT niche_key FROM shop_niche WHERE shop=?").all(opts.shop) as any[])
      .map((r) => r.niche_key)
      .filter(Boolean);
  }
  if (!nicheKeys.length) throw new Error(`Shop "${opts.shop}" chưa gán ngách (shop_niche) — không biết kéo gì.`);

  // 2. Demand Kalodata (cho demandFit). Rỗng → fallback 50.
  const kaloDay = kalodataStore.latestDay();
  const kaloCats = kaloDay ? kalodataStore.listCategories(kaloDay) : [];

  // 3. Dedup PER-SHOP (không toàn cục nữa — 1 sp list được nhiều shop, tối đa cap).
  //    existingForShop = sp đã có CHO SHOP NÀY; shopCountByGid = số shop distinct/sp (cho cap).
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

  const niches: PullMoreNiche[] = [];
  const samples: PullMoreResult["samples"] = [];
  let totalInserted = 0;

  for (const nicheKey of nicheKeys) {
    const ncfg = cfg.niches?.find((n) => n.key === nicheKey);
    const query = ncfg?.query || nicheKey.replace(/-/g, " ");
    const group = ncfg?.group || "";

    // 3a. Gom sp — TIẾP từ con trỏ trang (không lặp lại trang 1 mỗi lần).
    const startPage = readCursor(db, nicheKey, opts.resetCursor === true) + 1;
    const endPage = startPage + pages - 1;
    log(`🔎 [${nicheKey}] search "${query}" (trang ${startPage}→${endPage} × ${perPage})…`);

    const seen = new Set<string>();
    const products: any[] = [];
    let lastReadPage = startPage - 1;
    let exhausted = false;
    for (let page = startPage; page <= endPage; page++) {
      try {
        const res = await searchProducts(query, { page, perPage, country: cfg.country });
        for (const p of res.products) {
          const gid = String(p.goodsId || "");
          if (!/^\d{5,}$/.test(gid) || seen.has(gid)) continue;
          seen.add(gid);
          products.push(p);
        }
        lastReadPage = page;
        if (!res.hasNext || res.products.length === 0) { exhausted = true; break; }
      } catch (e: any) {
        log(`   ⚠️ trang ${page} lỗi: ${String(e?.message ?? e).slice(0, 60)}`);
        break;
      }
    }
    // Lưu con trỏ: hết trang → đánh dấu exhausted (lần sau vòng lại trang 1).
    if (!opts.dryRun) writeCursor(db, nicheKey, lastReadPage, exhausted);

    // 3a-bis. Nguồn PHỤ: recommendedProducts từ 3 winner của shop trong ngách này
    // (sp tương tự winner — ít trùng với keyword search). Best-effort.
    let recommendedCount = 0;
    if (useRecommended) {
      const seeds = (
        db.prepare(
          `SELECT goods_id FROM shop_allocation
           WHERE shop=? AND niche_key=? AND status IN ('crawled','listed')
           ORDER BY opportunity_score DESC LIMIT 3`
        ).all(opts.shop, nicheKey) as any[]
      ).map((r) => String(r.goods_id));
      for (const seed of seeds) {
        try {
          const recs = await recommendedProducts(seed, { limit: 20, country: cfg.country.toUpperCase() });
          for (const p of recs) {
            const gid = String(p.goodsId || "");
            if (!/^\d{5,}$/.test(gid) || seen.has(gid)) continue;
            seen.add(gid);
            products.push(p);
            recommendedCount++;
          }
        } catch { /* seed lỗi → bỏ qua */ }
      }
    }

    // 3b. Loại: đã có CHO SHOP NÀY / excluded / đã đạt cap số shop / hàng trẻ em.
    const fresh = products.filter((p) => {
      const gid = String(p.goodsId);
      if (existingForShop.has(gid) || excluded.has(gid)) return false;
      if ((shopCountByGid.get(gid) || 0) >= capN) return false;
      if (isKidsProduct((p as any).name, (p as any).catName)) return false; // loại hàng trẻ em
      return true;
    });

    // 3c. Chấm điểm (đúng chuỗi research)
    const wins: WinScored[] = fresh.map(scoreWin);
    const rollup = rollupNiche(wins);
    const dm = matchNicheDemand({ key: nicheKey, group, query } as any, kaloCats);

    const scored = wins
      .map((w) => {
        const opp = scoreOpportunity({ win: w, nicheHeat: rollup.heatScore, demandFit: dm.demandFit });
        return { w, opportunityScore: opp.opportunityScore };
      })
      .filter((x) => x.opportunityScore >= minOpp)
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    // 3d. Insert (trừ dry-run)
    let inserted = 0;
    const now = Date.now();
    for (const { w, opportunityScore } of scored) {
      const gid = String(w.goodsId);
      if (!opts.dryRun) {
        const info = ins.run(
          gid, opts.shop, nicheKey, w.name ?? "",
          Math.round(w.winScore), Math.round(opportunityScore),
          w.price ?? null,
          w.url || `https://us.shein.com/-p-${gid}.html`,
          w.image ?? "",
          now
        );
        if (info.changes > 0) { inserted++; shopCountByGid.set(gid, (shopCountByGid.get(gid) || 0) + 1); }
      }
      existingForShop.add(gid); // tránh insert lại cho SHOP NÀY trong cùng phiên (ngách khác)
      if (samples.length < 8) {
        samples.push({ goodsId: gid, name: (w.name ?? "").slice(0, 60), opportunityScore: Math.round(opportunityScore), winScore: Math.round(w.winScore), price: w.price ?? null });
      }
    }
    totalInserted += inserted;

    niches.push({
      nicheKey, query,
      pageFrom: startPage, pageTo: lastReadPage,
      searched: products.length, fresh: fresh.length, passed: scored.length, inserted,
      recommended: recommendedCount,
      heatScore: rollup.heatScore, demandFit: dm.demandFit,
    });
    log(
      `   ✓ trang ${startPage}-${lastReadPage}${exhausted ? " (hết→vòng lại)" : ""} · ${products.length} tìm thấy` +
      `${recommendedCount ? ` (+${recommendedCount} recommended)` : ""} · ${fresh.length} mới · ` +
      `${scored.length} đạt điểm (≥${minOpp}) · ${opts.dryRun ? "DRY-RUN" : inserted + " nạp"} · nhiệt ${rollup.heatScore}`
    );
  }

  return { shop: opts.shop, niches, totalInserted, minOpportunity: minOpp, samples };
}
