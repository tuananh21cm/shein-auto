/**
 * Kalodata collector qua Kiki (Kalodata bị Cloudflare → browser thường bị chặn).
 * Lifecycle: inject cookie config/kalodata.json → mở kalodata.com/category (Kiki
 * pass CF) → gọi API NỘI BỘ trang bằng page.evaluate(fetch) (cùng origin, đã qua
 * CF + có cookie) → paginate. Trả category demand + product best-seller (TikTok US).
 *
 * Endpoint (đào ở kalodataProbe):
 *   POST /v1/tiktok/categories   — demand theo ngách
 *   POST /product/queryList      — best-seller theo sản phẩm
 */
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../kiki/client";
import { parseKaloNum, trendSlope } from "./parse";
import { isFashionCategory } from "../../core/research/fashionFilter";

export interface KaloCategory {
  cateId: string;
  numericId: string | null;     // id số (dùng filter product theo ngách)
  name: string;
  level: string;
  revenue: number | null;
  growthRate: number | null;     // 0..1
  shopNumber: number | null;
  avgRevenue: number | null;
  top3Ratio: number | null;
  top10Ratio: number | null;
  trendSlope: number | null;
}
export interface KaloProduct {
  productId: string;
  title: string;
  revenue: number | null;
  sale: number | null;
  unitPrice: number | null;
  commissionRate: number | null;
  rating: number | null;
  isLocal: boolean | null;
  launchDate: string | null;
  creatorNum: number | null;
  priCateId: string | null;
  cateFilter?: string | null;   // tên category được pull theo (drill-down). NULL = global top.
}
export interface CollectParams {
  profileId: string;
  country?: string;
  startDate?: string;            // YYYY-MM-DD; default last-30-days
  endDate?: string;
  categoryPages?: number;        // số trang category (pageSize 50)
  productPages?: number;
  perCategoryTop?: number;       // pull product cho top N fashion category (drill-down)
  onLog?: (m: string) => void;
}
export interface CategoryProducts {
  name: string;
  numericId: string;
  products: KaloProduct[];
}
export interface CollectResult {
  startDate: string;
  endDate: string;
  categories: KaloCategory[];
  products: KaloProduct[];
  categoryProducts: CategoryProducts[];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cookie export (extension) → Playwright addCookies format. */
function toPlaywrightCookies(raw: any[]): any[] {
  const ss = (s: any): "Strict" | "Lax" | "None" => {
    const v = String(s || "").toLowerCase();
    if (v === "no_restriction" || v === "none") return "None";
    if (v === "strict") return "Strict";
    return "Lax";
  };
  const out: any[] = [];
  for (const c of raw) {
    if (!c?.name || c.value == null || !c.domain) continue;
    let sameSite = ss(c.sameSite);
    const secure = !!c.secure;
    if (sameSite === "None" && !secure) sameSite = "Lax";
    const ck: any = {
      name: c.name, value: String(c.value), domain: c.domain, path: c.path || "/",
      httpOnly: !!c.httpOnly, secure, sameSite,
    };
    if (typeof c.expirationDate === "number") ck.expires = Math.floor(c.expirationDate);
    out.push(ck);
  }
  return out;
}

function loadCookies(): any[] {
  const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config", "kalodata.json"), "utf8"));
  return toPlaywrightCookies(Array.isArray(j) ? j : j.cookies || []);
}

function normCategory(it: any): KaloCategory {
  return {
    cateId: String(it.cate_id ?? it.id ?? ""),
    numericId: it.id != null ? String(it.id) : null,
    name: String(it.name ?? it.cate_id ?? ""),
    level: String(it.level ?? ""),
    revenue: parseKaloNum(it.revenue),
    growthRate: typeof it.revenue_growth_rate === "number" ? it.revenue_growth_rate : null,
    shopNumber: Number(it.shop_number) || null,
    avgRevenue: parseKaloNum(it.average_revenue),
    top3Ratio: typeof it.top_3_shop_revenue_ratio === "number" ? it.top_3_shop_revenue_ratio : null,
    top10Ratio: typeof it.top_10_shop_revenue_ratio === "number" ? it.top_10_shop_revenue_ratio : null,
    trendSlope: trendSlope(it.revenue_trend),
  };
}
function normProduct(it: any): KaloProduct {
  return {
    productId: String(it.id ?? ""),
    title: String(it.product_title ?? "").slice(0, 200),
    revenue: parseKaloNum(it.revenue),
    sale: Number(it.sale) || null,
    unitPrice: parseKaloNum(it.unit_price),
    commissionRate: typeof it.commission_rate === "number" ? it.commission_rate : null,
    rating: typeof it.product_rating === "number" ? it.product_rating : null,
    isLocal: it.delivery_type ? String(it.delivery_type).toLowerCase() === "local" : it.is_overseas === 0 ? true : it.is_overseas === 1 ? false : null,
    launchDate: it.launch_date ? String(it.launch_date) : null,
    creatorNum: Number(it.creator_num) || null,
    priCateId: it.pri_cate_id != null ? String(it.pri_cate_id) : null,
  };
}

export async function collectKalodata(params: CollectParams): Promise<CollectResult> {
  const log = params.onLog ?? (() => {});
  const country = params.country ?? "US";
  const endDate = params.endDate ?? ymd(new Date(Date.now() - 86400000));
  const startDate = params.startDate ?? ymd(new Date(Date.now() - 30 * 86400000));
  const categoryPages = params.categoryPages ?? 4;  // ~200 category
  const productPages = params.productPages ?? 5;     // ~250 product
  const profileId = params.profileId;

  const cookies = loadCookies();
  log(`🍪 ${cookies.length} cookie · range ${startDate}…${endDate}`);

  log(`Force-stop Kiki ${profileId}…`);
  await kiki.forceStop(profileId);
  const started = await kiki.startWithRetry(profileId, log);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const categories: KaloCategory[] = [];
  const products: KaloProduct[] = [];
  const categoryProducts: CategoryProducts[] = [];

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    await ctx.addCookies(cookies).catch(async (e) => {
      log(`addCookies lỗi (thử từng cái): ${e?.message}`);
      for (const c of cookies) await ctx.addCookies([c]).catch(() => {});
    });
    const page = await ctx.newPage();

    log("Mở kalodata.com/category (pass Cloudflare)…");
    await page.goto("https://www.kalodata.com/category", { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 12; i++) {
      const title = await page.title().catch(() => "");
      if (!/just a moment|attention required|checking your browser/i.test(title)) break;
      log(`⏳ Cloudflare… (${i + 1})`);
      await sleep(2500);
    }
    await sleep(2500);

    // Gọi API nội bộ trang (cùng origin, đã qua CF + cookie).
    const apiPost = (endpoint: string, body: any): Promise<any> =>
      page.evaluate(
        async ({ endpoint, body }: any) => {
          const r = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
          });
          return await r.json().catch(() => null);
        },
        { endpoint, body }
      );

    const baseBody = { country, startDate, endDate, cateIds: [], showCateIds: [], sort: [{ field: "revenue", type: "DESC" }] };

    // ── Categories ──
    for (let p = 1; p <= categoryPages; p++) {
      const j = await apiPost("/v1/tiktok/categories", { ...baseBody, pageNo: p, pageSize: 50 });
      const list: any[] = j?.data?.list ?? j?.data?.items ?? (Array.isArray(j?.data) ? j.data : []);
      if (!Array.isArray(list) || list.length === 0) break;
      for (const it of list) categories.push(normCategory(it));
      log(`📊 category trang ${p}: +${list.length} (tổng ${categories.length})`);
      if (list.length < 50) break;
      await sleep(800);
    }

    // ── Products ──
    for (let p = 1; p <= productPages; p++) {
      const j = await apiPost("/product/queryList", { ...baseBody, pageNo: p, pageSize: 50 });
      const list: any[] = j?.data?.list ?? j?.data?.items ?? (Array.isArray(j?.data) ? j.data : []);
      if (!Array.isArray(list) || list.length === 0) break;
      for (const it of list) products.push(normProduct(it));
      log(`🛍️ product trang ${p}: +${list.length} (tổng ${products.length})`);
      if (list.length < 50) break;
      await sleep(800);
    }

    // ── Product theo từng top fashion category (cho drill-down) ──
    const perCatTop = params.perCategoryTop ?? 0;
    if (perCatTop > 0) {
      const topFashion = categories
        .filter((c) => c.numericId && isFashionCategory(c.name))
        .sort((a, b) => (b.growthRate ?? -9) - (a.growthRate ?? -9))
        .slice(0, perCatTop);
      log(`🛒 Pull product cho ${topFashion.length} top fashion category…`);
      for (const c of topFashion) {
        const j = await apiPost("/product/queryList", { ...baseBody, cateIds: [c.numericId], pageNo: 1, pageSize: 50 });
        const list: any[] = j?.data?.list ?? j?.data?.items ?? (Array.isArray(j?.data) ? j.data : []);
        const prods = (list || []).map((it) => ({ ...normProduct(it), cateFilter: c.name }));
        categoryProducts.push({ name: c.name, numericId: c.numericId!, products: prods });
        log(`   [${c.name}] +${prods.length}`);
        await sleep(700);
      }
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
  }

  log(`✅ Kalodata: ${categories.length} category · ${products.length} product · ${categoryProducts.length} ngách drill.`);
  return { startDate, endDate, categories, products, categoryProducts };
}
