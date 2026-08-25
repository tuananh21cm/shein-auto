/**
 * Gợi ý SP win trên SHEIN theo NGÁCH của từng shop TikCRM.
 *
 * Luồng v1 (chỉ RapidAPI, không Kiki/Apify):
 *   1. Ngách shop = top_categories[0] của fourseller (vd "Kitchen Tools", "Women's Tanks & Camis").
 *      — hoặc override thủ công (data/tikcrm/shein_override.json) nếu map sai.
 *   2. Map tên ngách → SHEIN catId bằng fuzzy-match vào cây getCategories() (1.4k node).
 *   3. bestSellersByCategory(catId) → top SP win (ảnh/giá/discount/link).
 *   4. Lưu snapshot ngày qua recordDaily("sheinsuggest") → buildReport đọc getLatestKindSnapshot.
 *
 * Cron chạy sau refreshFourSeller (cần top_categories). Trong 1 lần chạy, cache bestseller
 * theo catId (nhiều shop chung ngách → 1 lần gọi API).
 */
import fs from "fs-extra";
import path from "path";
import { getCategories, bestSellersByCategory, searchProducts } from "../shein/client";
import { runActorAndGetItems, apifyToken } from "../apify/client";
import { recordDaily, getLatestKindSnapshot } from "./dailyStore";

const APIFY_ACTOR = "scraper-engine~shein-search-products-scraper";
const num = (v: any): number | null => { const n = parseFloat(String(v ?? "").replace("%", "")); return Number.isFinite(n) ? n : null; };
const httpsImg = (u: any): string => { let s = String(u || ""); if (s.startsWith("//")) s = "https:" + s; else if (s.startsWith("http://")) s = "https://" + s.slice(7); return s; };

const DAILY_ROOT = path.resolve(process.cwd(), "data", "tikcrm", "daily");
const OVERRIDE_FILE = path.resolve(process.cwd(), "data", "tikcrm", "shein_override.json");

export interface SheinWinItem {
  goodsId: string; sku?: string; name: string; image: string; url: string;
  price: number | null; retailPrice: number | null; discountPct: number | null;
  catName?: string; storeCode?: string;
  rating?: number | null; reviewCount?: number | null; badge?: string; fitPercent?: number | null;
}
export interface SheinSuggest {
  niche: string; cat_id: string; cat_name: string; matched_score: number;
  source: "auto" | "override" | "search"; engine: "apify" | "rapidapi";
  count: number; coherence: number; products: SheinWinItem[];
}

/** Map 1 item của actor Apify scraper-engine → SheinWinItem (kèm rating/review/badge). */
function mapApify(it: any): SheinWinItem {
  const label = String(it.rankInfoLabel || "");
  const fit = it.percent_overall_fit;
  return {
    goodsId: String(it.goods_id || ""),
    sku: String(it.spu || it.fromSkuCode || it.productRelationID || ""),
    name: String(it.goods_name || ""),
    image: httpsImg(it.goods_img || (Array.isArray(it.imageGallery) ? it.imageGallery[0] : "")),
    url: String(it.productUrl || (it.goods_id ? `https://us.shein.com/-p-${it.goods_id}.html` : "")),
    price: num(it.salePriceUsd), retailPrice: num(it.retailPriceUsd),
    discountPct: it.discountPercent != null ? Number(it.discountPercent) : null,
    catName: it.categoryName, storeCode: it.storeCode ? String(it.storeCode) : undefined,
    rating: num(it.ratingValue), reviewCount: it.reviewCount != null ? Number(it.reviewCount) : null,
    badge: /bestseller/i.test(label) ? label : "",
    fitPercent: num(fit?.true_size ?? fit?.trueSize),
  };
}

/** Kéo SP win theo ngách qua Apify actor (search MostPopular). Throw nếu lỗi/rỗng. */
async function apifyWinByNiche(niche: string, limit: number, log: (m: string) => void): Promise<SheinWinItem[]> {
  const items = await runActorAndGetItems<any>(
    APIFY_ACTOR,
    { query: [niche], countryCode: "us", orderBy: "MostPopular", maxItems: Math.max(limit, 12), dedupeAcrossQueries: true },
    { timeoutMinutes: 15, onLog: (m) => log("   " + m) }
  );
  return items.map(mapApify).filter((x) => x.goodsId).slice(0, limit);
}

/** Tỉ lệ SP có cate_name trùng token với ngách/cat map → phát hiện endpoint trả lệch ngách. */
function coherence(products: SheinWinItem[], niche: string, catName: string): number {
  if (!products.length) return 0;
  const want = new Set([...toks(niche), ...toks(catName)]);
  if (!want.size) return 1;
  let hit = 0;
  for (const p of products) if (toks(p.catName || "").some((t) => want.has(t))) hit++;
  return hit / products.length;
}

/* ─── Cây category SHEIN (cache 6h) ─── */
interface CatNode { catId: string; name: string; depth: number; }
let _tree: { at: number; nodes: CatNode[] } | null = null;
async function sheinTree(): Promise<CatNode[]> {
  if (_tree && Date.now() - _tree.at < 6 * 3600_000) return _tree.nodes;
  const raw = await getCategories("us");
  const nodes: CatNode[] = [];
  const walk = (arr: any[], depth: number) => {
    for (const n of arr || []) {
      const id = n?.cat_id ?? n?.categoryId ?? n?.id;
      const name = n?.name ?? n?.cat_name ?? n?.categoryName;
      if (id && name) nodes.push({ catId: String(id), name: String(name), depth });
      walk(n?.children ?? n?.subCategories ?? n?.child ?? n?.sub ?? [], depth + 1);
    }
  };
  walk(raw, 0);
  _tree = { at: Date.now(), nodes };
  return nodes;
}

/* ─── Fuzzy map tên ngách → node SHEIN ─── */
const STOP = new Set(["women", "womens", "woman", "men", "mens", "man", "kids", "kid", "unisex", "girls", "boys", "and", "the", "for", "with", "set", "sets", "new", "shein", "amp", "clothing", "apparel", "other", "others", "accessories"]);
const stem = (t: string) => t.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
function toks(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((t) => t.length >= 2 && !STOP.has(t)).map(stem);
}
/** Trả node khớp nhất (hoặc null nếu không đủ tin cậy). */
export function matchNiche(niche: string, nodes: CatNode[]): { node: CatNode; score: number } | null {
  const nt = toks(niche);
  if (!nt.length) return null;
  const ntSet = new Set(nt);
  let best: { node: CatNode; score: number } | null = null;
  for (const node of nodes) {
    const mt = toks(node.name);
    if (!mt.length) continue;
    const mtSet = new Set(mt);
    let shared = 0;
    for (const t of ntSet) if (mtSet.has(t)) shared++;
    if (!shared) continue;
    // điểm: token chung ×2, trừ nhẹ token thừa của node (ưu tiên node "khít"), cộng độ sâu (cụ thể hơn)
    const extra = mt.length - shared;
    const score = shared * 2 - extra * 0.25 + node.depth * 0.3 + (shared === ntSet.size ? 1 : 0);
    if (!best || score > best.score) best = { node, score };
  }
  return best && best.score >= 1.5 ? best : null;
}

/* ─── Override thủ công ─── */
type OverrideMap = Record<string, { cat_id: string; cat_name: string; niche?: string }>;
function readOverride(): OverrideMap {
  try { return fs.existsSync(OVERRIDE_FILE) ? fs.readJsonSync(OVERRIDE_FILE) : {}; } catch { return {}; }
}
export function setSheinOverride(code: string, cat_id: string, cat_name: string, niche?: string) {
  const m = readOverride();
  m[code] = { cat_id: String(cat_id), cat_name: String(cat_name), niche };
  fs.ensureDirSync(path.dirname(OVERRIDE_FILE));
  fs.writeJsonSync(OVERRIDE_FILE, m, { spaces: 1 });
}

/** Ngách chính của shop: top_categories[0] của fourseller snapshot mới nhất. */
export function getShopNiche(code: string): string | null {
  const fs4 = getLatestKindSnapshot(code, "fourseller")?.data;
  const cats = fs4?.top_categories;
  if (Array.isArray(cats) && cats.length && cats[0]?.name) return String(cats[0].name);
  return null;
}

const compact = (p: any): SheinWinItem => ({
  goodsId: p.goodsId, sku: p.goodsSn || p.goods_sn || "", name: p.name, image: p.image,
  url: p.url || (p.goodsId ? `https://us.shein.com/-p-${p.goodsId}.html` : ""),
  price: p.price ?? null, retailPrice: p.retailPrice ?? null, discountPct: p.discountPct ?? null,
  catName: p.catName, storeCode: p.storeCode,
});

/**
 * Lưu LỊCH SỬ mọi SP đã recommend cho shop (union theo goods_id, kèm SKU + link SHEIN).
 * Tích luỹ qua mọi lần chạy → sau này lọc SP đã list theo SKU. File: shein_recommend_history/<code>.json
 */
function recordRecommendHistory(code: string, niche: string, products: SheinWinItem[]): void {
  try {
    const dir = path.resolve(process.cwd(), "data", "tikcrm", "shein_recommend_history");
    fs.ensureDirSync(dir);
    const f = path.join(dir, code.replace(/[^\w.-]/g, "_") + ".json");
    const hist: Record<string, any> = fs.existsSync(f) ? fs.readJsonSync(f) : {};
    const now = new Date().toISOString();
    for (const p of products) {
      if (!p.goodsId) continue;
      const cur = hist[p.goodsId];
      if (cur) { cur.last_at = now; cur.times = (cur.times || 1) + 1; if (p.sku && !cur.sku) cur.sku = p.sku; }
      else hist[p.goodsId] = { goods_id: p.goodsId, sku: p.sku || "", name: p.name, url: p.url, price: p.price, niche, first_at: now, last_at: now, times: 1, listed: false };
    }
    fs.writeJsonSync(f, hist);
  } catch { /* history không chặn recommend */ }
}

/**
 * Sinh gợi ý cho 1 shop. bestCache: reuse bestseller theo catId trong 1 lần chạy batch.
 * Trả null nếu không xác định được ngách/không map được.
 */
export async function refreshSheinSuggestForShop(
  code: string,
  opts: { limit?: number; bestCache?: Map<string, SheinWinItem[]>; onLog?: (m: string) => void; apify?: boolean } = {}
): Promise<SheinSuggest | null> {
  const log = opts.onLog ?? (() => {});
  const limit = opts.limit ?? 20;
  const ov = readOverride()[code];

  const nicheRaw = ov?.niche || ov?.cat_name || getShopNiche(code);
  if (!nicheRaw) { log(`${code}: chưa có ngách (thiếu fourseller top_categories)`); return null; }
  const niche = String(nicheRaw);
  const source: "auto" | "override" = ov?.cat_id ? "override" : "auto";

  let products: SheinWinItem[] | undefined;
  let engine: "apify" | "rapidapi" = "apify";
  let catId = ov?.cat_id || "";
  let catName = ov?.cat_name || niche;
  let matched = ov?.cat_id ? 99 : 0;
  let coh = 1;

  // ── Apify search theo ngách (rating + review + badge). CHỈ khi opts.apify=true — Apify dùng residential
  //    proxy ~1GB/run ≈ $1–2.5/run → KHÔNG chạy hàng loạt/cron (đã từng cạn $29/tháng). Mặc định RapidAPI. ──
  if (opts.apify && apifyToken()) {
    const key = "apify:" + niche.toLowerCase();
    products = opts.bestCache?.get(key);
    if (!products) {
      try {
        log(`${code}: Apify search "${niche}"…`);
        const ap = await apifyWinByNiche(niche, limit, log);
        if (ap.length >= 4) { products = ap; opts.bestCache?.set(key, ap); }
        else log(`${code}: Apify trả ${ap.length} SP (<4) → fallback RapidAPI`);
      } catch (e: any) { log(`${code}: Apify lỗi ${String(e?.message || e).slice(0, 80)} → fallback RapidAPI`); }
    }
  }

  // ── FALLBACK: RapidAPI bycategory/best (cần catId; coherence guard + search) ──
  if (!products || products.length < 4) {
    engine = "rapidapi";
    if (!catId) {
      const m = matchNiche(niche, await sheinTree());
      if (!m) { log(`${code}: fallback không map được "${niche}" → SHEIN`); return null; }
      catId = m.node.catId; catName = m.node.name; matched = Math.round(m.score * 10) / 10;
    }
    let rp = opts.bestCache?.get("rapid:" + catId);
    if (!rp) {
      const b = await bestSellersByCategory(catId, { perPage: limit, country: "us" });
      rp = b.products.map(compact).filter((x) => x.goodsId);
      opts.bestCache?.set("rapid:" + catId, rp);
    }
    coh = coherence(rp, niche, catName);
    if (source === "auto" && coh < 0.34) {
      log(`${code}: cat ${catId} lệch ngách (coh ${coh.toFixed(2)}) → thử searchProducts`);
      try {
        const s = await searchProducts(niche, { perPage: limit, country: "us" });
        const sp = s.products.map(compact).filter((x) => x.goodsId);
        if (sp.length >= 4) { rp = sp; coh = 1; catName = `${catName} · search`; }
      } catch { /* search chập chờn */ }
    }
    if (!rp.length) { log(`${code}: không nguồn SHEIN nào có SP cho "${niche}" → bỏ qua`); return null; }
    products = rp;
  } else {
    engine = "apify"; catName = niche;
  }

  const suggest: SheinSuggest = {
    niche, cat_id: engine === "apify" ? "apify" : catId, cat_name: catName,
    matched_score: matched, source, engine, count: products.length,
    coherence: Math.round(coh * 100) / 100, products,
  };
  recordDaily("sheinsuggest", { payload: { shop_code: code, ...suggest } });
  recordRecommendHistory(code, niche, products);   // lưu union theo SKU để sau lọc SP đã list
  log(`${code}: ngách "${niche}" → ${engine} · ${products.length} SP${engine === "rapidapi" ? ` · coh=${suggest.coherence}` : ""}`);
  return suggest;
}

/** Toàn bộ shop có data. Reuse bestseller theo catId. */
export async function refreshSheinSuggestAll(onLog?: (m: string) => void): Promise<{ ok: number; skip: number }> {
  const log = onLog ?? (() => {});
  let codes: string[] = [];
  try { codes = fs.readdirSync(DAILY_ROOT).filter((d) => /^[\w.-]+$/.test(d) && fs.statSync(path.join(DAILY_ROOT, d)).isDirectory()); } catch { /* */ }
  const bestCache = new Map<string, SheinWinItem[]>();
  let ok = 0, skip = 0;
  for (const code of codes) {
    try {
      const r = await refreshSheinSuggestForShop(code, { bestCache, onLog });
      if (r) ok++; else skip++;
    } catch (e: any) { skip++; log(`${code}: lỗi ${e?.message || e}`); }
  }
  log(`SHEIN suggest xong: ${ok} shop có gợi ý, ${skip} bỏ qua. (${bestCache.size} ngách gọi API)`);
  return { ok, skip };
}
