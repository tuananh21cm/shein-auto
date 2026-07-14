/**
 * sheinScraperV2 — "ID-first": KHÔNG dựa vào SPA re-render.
 *
 * Gốc bug cũ: 1 goods_id = 1 MÀU. Click swatch = chuyển SPA → URL đổi ĐÚNG nhưng DOM/ảnh
 * re-render bất đồng bộ → đọc trúng ảnh màu cũ ("URL nhảy mà data không nhảy"). Code cũ chữa bằng
 * poll ảnh 12 lần + force-click ×3 + restart session → chính retry storm đó mới kích captcha.
 *
 * V2:
 *   Pass 1 — click từng swatch CHỈ để đọc window.location (URL luôn đổi đúng) → thu N goods_id.
 *            Không đọc DOM, không chờ render ⇒ không thể "kẹt".
 *   Pass 2 — goto('-p-<colorGoodsId>.html') từng màu = FRESH LOAD ⇒ DOM luôn đúng màu đó.
 *            Dùng lại nguyên bộ trích DOM cũ (scrapeSheinProduct với noClick) + ĐÈ size/tồn/giá
 *            bằng JSON từ BFF `get_goods_detail_realtime_data` (chắc chắn hơn parse DOM).
 */
import type { Page } from "playwright-core";
import { scrapeSheinProduct, type ScrapeOptions, type ScrapeResult } from "./sheinScraper";

const SWATCH_SEL =
  '.main-sales-attr__color-container .radio-container, .radio-container[role="radio"], [class*="color-radio"]';

export interface ColorRef {
  goodsId: string;
  /** Tên màu đọc từ label lúc thu (có thể trùng → dedupe khi merge). */
  name: string;
}

/** Số liệu chắc chắn lấy từ BFF realtime_data của MỘT màu. */
export interface RealtimeInfo {
  goodsId: string | null;
  /** size → tồn kho (0 = hết hàng). */
  sizeStock: Record<string, number>;
  salePrice: string | null;
  retailPrice: string | null;
}

/** Parse BFF get_goods_detail_realtime_data → size/tồn/giá (path đã verify 2026-07-11). */
export function parseRealtime(info: any): RealtimeInfo {
  const out: RealtimeInfo = { goodsId: null, sizeStock: {}, salePrice: null, retailPrice: null };
  if (!info) return out;
  out.goodsId = info?.productInfo?.goods_id != null ? String(info.productInfo.goods_id) : null;
  out.salePrice = info?.priceInfo?.salePrice?.amount ?? null;
  out.retailPrice = info?.priceInfo?.retailPrice?.amount ?? null;
  const skus: any[] = info?.saleAttr?.multiLevelSaleAttribute?.sku_list ?? [];
  for (const s of skus) {
    // sku_sale_attr: [{attr_name:"Size", attr_value_name:"M"}] — sp SHEIN 1 goods_id chỉ còn thuộc tính Size.
    const size = (s?.sku_sale_attr ?? [])
      .filter((a: any) => /size|größe|taille/i.test(String(a?.attr_name ?? "")))
      .map((a: any) => String(a?.attr_value_name ?? "").trim())
      .filter(Boolean)[0];
    if (!size) continue;
    const stock = Number(s?.stock ?? 0);
    out.sizeStock[size] = Number.isFinite(stock) ? stock : 0;
  }
  return out;
}

/** Bắt realtime_data của LẦN LOAD kế tiếp. Gọi TRƯỚC goto. */
function catchRealtime(page: Page): { get: () => Promise<any | null>; detach: () => void } {
  let resolve: ((v: any) => void) | null = null;
  let got: any = null;
  const p = new Promise<any>((r) => { resolve = r; });
  const onResp = async (res: any) => {
    try {
      if (got || !/get_goods_detail_realtime_data/.test(res.url())) return;
      const j = await res.json().catch(() => null);
      const info = j?.info ?? j;
      if (!info) return;
      got = info;
      resolve?.(info);
    } catch { /* ignore */ }
  };
  page.on("response", onResp);
  return {
    get: async () => {
      if (got) return got;
      // chờ tối đa 12s; không có thì trả null (fallback DOM)
      return await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 12_000))]);
    },
    detach: () => page.off("response", onResp),
  };
}

/**
 * PASS 1 — thu goods_id của TỪNG MÀU bằng cách click swatch và CHỈ đọc URL.
 * Không đọc DOM/ảnh ⇒ không có khái niệm "kẹt". Trả [] nếu sp chỉ 1 màu (không swatch).
 */
export async function collectColorIds(page: Page, opts: { maxColors?: number; delayMs?: number; onLog?: (m: string) => void } = {}): Promise<ColorRef[]> {
  const log = opts.onLog ?? (() => {});
  const delay = opts.delayMs ?? 700;

  // Mở hết "Show More Colors" trước khi đếm swatch.
  await page.evaluate(`(async function(){
    var wait=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
    for(var k=0;k<6;k++){
      var btn=[].slice.call(document.querySelectorAll('div,span,button,a')).find(function(e){
        var t=(e.innerText||"").trim(); return /^(show more|more colors|xem thêm)/i.test(t);});
      if(!btn) break;
      btn.click(); await wait(600);
    }
  })()`).catch(() => {});

  const n = await page.locator(SWATCH_SEL).count().catch(() => 0);
  if (n < 2) { log(`   1 màu (không swatch) → bỏ pass 1`); return []; }
  const limit = opts.maxColors && opts.maxColors > 0 ? Math.min(opts.maxColors, n) : n;
  log(`   ${n} swatch → thu goods_id từng màu (chỉ đọc URL)…`);

  const refs: ColorRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const r = await page.evaluate(`(async function(){
      var wait=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
      var idOf=function(){var m=location.href.match(/-p-(\\d+)\\.html/); return m?m[1]:null;};
      var before=idOf();
      var sw=document.querySelectorAll('${SWATCH_SEL}')[${i}];
      if(!sw) return {err:"no-swatch"};
      sw.scrollIntoView({block:"center"});
      sw.click();
      // CHỜ URL ĐỔI (luôn đáng tin) — KHÔNG chờ DOM/ảnh.
      for(var t=0;t<20;t++){ await wait(150); if(idOf()!==before) break; }
      var name=(document.querySelector('.color-block .sub-title, [class*="color-block"] .sub-title')||{}).innerText||"";
      return {id:idOf(), name:String(name).trim(), changed: idOf()!==before};
    })()`) as any;
    if (r?.id && !seen.has(r.id)) {
      seen.add(r.id);
      refs.push({ goodsId: String(r.id), name: r.name || `Color ${i + 1}` });
    }
    await page.waitForTimeout(delay + Math.floor(Math.random() * 400)); // pacing nhẹ
  }
  log(`   thu được ${refs.length}/${limit} goods_id màu`);
  return refs;
}

/**
 * Cào 1 sp theo mô hình V2. `page` phải ĐANG ở trang sp (caller đã goto + qua captcha).
 * Trả ScrapeResult y hệt shape cũ → pipeline (dispatch/4Seller) không phải đổi gì.
 */
export async function scrapeSheinProductV2(
  page: Page,
  opts: ScrapeOptions & {
    onLog?: (m: string) => void;
    /** Gọi sau MỖI goto màu để xử captcha (ensureNoCaptcha/dismissCaptcha) — mỗi màu là fresh load. */
    onCaptcha?: (page: Page) => Promise<void>;
  } = {}
): Promise<ScrapeResult> {
  const log = opts.onLog ?? (() => {});
  const host = new URL(page.url()).origin;
  // opts truyền vào page.evaluate phải SERIALIZE được → bỏ onLog (hàm) ra.
  const base: ScrapeOptions = {
    divide4: opts.divide4, maxColors: opts.maxColors, variantDelayMs: opts.variantDelayMs, noClick: true,
  };
  const pageOpts: ScrapeOptions = base;                                  // màu đầu: lấy đủ size_chart
  const lightOpts: ScrapeOptions = { ...base, skipSizeChart: true };     // màu 2..N: nhẹ, ~10s nhanh hơn

  // ── PASS 1: thu goods_id từng màu (chỉ URL) ──
  const colors = await collectColorIds(page, { maxColors: opts.maxColors, onLog: log });

  // Sp 1 màu → cào luôn trang hiện tại (noClick), khỏi goto lại.
  if (colors.length === 0) {
    const rt = catchRealtime(page);
    // realtime_data đã fire lúc caller goto → thử lấy ngay (không thì null → fallback DOM)
    const info = await rt.get().catch(() => null);
    rt.detach();
    const data = await scrapeSheinProduct(page, pageOpts);
    applyRealtime(data, info, log);
    return data;
  }

  // ── PASS 2: goto TỪNG MÀU (fresh load ⇒ DOM luôn đúng) ──
  let merged: ScrapeResult | null = null;
  const oos: string[] = [];
  const usedNames = new Map<string, number>();

  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const url = `${host}/-p-${c.goodsId}.html`;
    const rt = catchRealtime(page);
    log(`   [${i + 1}/${colors.length}] màu "${c.name}" → goto ${c.goodsId}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => log(`      goto warn: ${e?.message}`));
    // Chờ SP SẴN SÀNG + captcha per-load (mỗi màu là fresh load → có thể dính captcha/redirect).
    if (opts.onCaptcha) await opts.onCaptcha(page).catch(() => {});
    // Đợi tên sp xuất hiện (đã settle redirect) TRƯỚC khi evaluate → tránh "context destroyed".
    await page.waitForSelector(".product-intro__head-name, h1.product-intro__head-name", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const info = await rt.get().catch(() => null);
    rt.detach();

    // Trích DOM của ĐÚNG màu này (fresh load → không thể stale). Retry 1 lần nếu context vỡ (redirect muộn).
    // Màu ĐẦU: lấy đủ (kèm size_chart/measure/fit). Màu sau: nhẹ (bỏ drawer) → nhanh hơn ~10s/màu.
    const scrapeOne = merged ? lightOpts : pageOpts;
    let one;
    try {
      one = await scrapeSheinProduct(page, scrapeOne);
    } catch (e: any) {
      if (/context was destroyed|Execution context/i.test(String(e?.message))) {
        log(`      ↻ context vỡ (redirect) → chờ settle, thử lại`);
        await page.waitForTimeout(2500);
        await page.waitForSelector(".product-intro__head-name", { timeout: 15_000 }).catch(() => {});
        one = await scrapeSheinProduct(page, scrapeOne);
      } else throw e;
    }
    applyRealtime(one, info, log);

    const name0 = one.listing_variations.colors[0] || c.name || `Color ${i + 1}`;
    // dedupe tên trùng (SHEIN hay có nhiều màu cùng tên "Multicolor")
    const cnt = (usedNames.get(name0) ?? 0) + 1;
    usedNames.set(name0, cnt);
    const name = cnt === 1 ? name0 : `${name0} ${cnt}`;

    const sizes = one.available_matrix[name0] ?? [];
    if (!sizes.length) { oos.push(name); continue; } // hết hàng toàn bộ size → bỏ màu

    if (!merged) {
      // Màu đầu: lấy làm khung (name/category/attributes/size_chart/measure/fit/product_images)
      merged = { ...one, listing_variations: { colors: [], sizes: [] }, variant_ids: [], variant_images: [], variant_price: [], available_matrix: {} };
    }
    merged.listing_variations.colors.push(name);
    merged.variant_ids.push({ [name]: c.goodsId });
    merged.variant_images.push({ [name]: (one.variant_images[0]?.[name0] ?? []).slice(0, 9) });
    merged.variant_price.push({ [name]: one.variant_price[0]?.[name0] ?? "0" });
    merged.available_matrix[name] = sizes;
    // size_chart/measure/fit: nếu màu đầu thiếu mà màu sau có → bù
    if (!merged.size_chart && one.size_chart) merged.size_chart = one.size_chart;
    if (!merged.measure_guide && one.measure_guide) merged.measure_guide = one.measure_guide;
    if (!merged.fit_reviews && one.fit_reviews) merged.fit_reviews = one.fit_reviews;
  }

  if (!merged) throw new Error(`V2: cả ${colors.length} màu đều hết hàng/không đọc được.`);

  // Union size + meta
  const sizeSet = new Set<string>();
  for (const s of Object.values(merged.available_matrix)) s.forEach((x) => sizeSet.add(x));
  merged.listing_variations.sizes = [...sizeSet];
  merged.sizes_available = [...sizeSet];
  merged._meta = {
    oosColors: oos,
    colorCount: merged.listing_variations.colors.length,
    variantStuck: false,          // V2 KHÔNG THỂ kẹt (không dùng SPA re-render)
    stuckColors: [],
    expectedColors: colors.length,
    processedColors: merged.listing_variations.colors.length + oos.length,
  };
  log(`   ✓ V2: ${merged.listing_variations.colors.length} màu${oos.length ? ` (+${oos.length} OOS)` : ""} · ${merged.listing_variations.sizes.length} size`);
  return merged;
}

/** Đè size/tồn/giá của MÀU HIỆN TẠI bằng JSON BFF (chắc chắn hơn parse DOM). */
function applyRealtime(data: ScrapeResult, info: any, log: (m: string) => void): void {
  if (!info) { log(`      (không có realtime_data → dùng DOM)`); return; }
  const rt = parseRealtime(info);
  const color = data.listing_variations.colors[0];
  if (!color) return;
  // size CÒN HÀNG theo JSON (stock > 0) — chuẩn hơn đọc nút size bị disabled trên DOM
  const inStock = Object.entries(rt.sizeStock).filter(([, st]) => st > 0).map(([s]) => s);
  if (inStock.length) {
    data.available_matrix[color] = inStock;
    const set = new Set([...(data.sizes_available ?? []), ...inStock]);
    data.sizes_available = [...set];
    data.listing_variations.sizes = [...set];
  }
  if (rt.salePrice) {
    data.variant_price = [{ [color]: rt.salePrice }];
  }
}
