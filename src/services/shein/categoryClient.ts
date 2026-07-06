/**
 * categoryClient — cào DANH SÁCH sản phẩm theo NGÁCH từ endpoint SHEIN thật:
 *   POST/GET https://us.shein.com/bff-api/category/get_select_product_list?select_id=<id>&page=..&limit=120
 *
 * KHÁC RapidAPI (services/shein/client.ts): nguồn này là API GỐC của SHEIN nên field
 * giàu hơn — có percent_overall_fit (true-to-size), isHighestSales/isLowestPrice,
 * comment_rank_average, stock. Nhưng có LỚP ANTI-BOT nặng:
 *   - Gọi thẳng (axios/curl/fetch) → code 836000 (thiếu header SDK: armorToken, x-gw-auth,
 *     SmDeviceId, Anti-In). KHÔNG tái tạo được ngoài trình duyệt.
 *   - Cào quá nhanh / fetch thủ công → captcha_type=909 chặn cả phiên.
 * → Cách bền: để CHÍNH TRANG tự gọi (header do SDK sinh), ta chỉ NGHE response qua CDP.
 *
 * Cơ chế: connect Chrome đang mở (cùng CDP với autoCrawler) → mở page → gắn listener
 * response cho get_select_product_list → goto URL ngách (site tự fetch page 1, limit 120)
 * → cuộn NGƯỜI-HOÁ (pacing 3-7s) tối đa maxScrolls để site tự kéo page kế → gom + chuẩn hoá.
 * Thấy captcha → dừng NGAY, trả những gì đã gom (không cố giải).
 *
 * select_id lấy từ URL khi bấm vào 1 ngách trên SHEIN: .../<Name>-sc-<selectId>.html
 * (vd Women Clothing = 017172961).
 */
import { chromium, type Page, type Browser } from "playwright-core";
import type { SheinProduct } from "./types";

const httpsImg = (u?: string | null): string => {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
};

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? (v.usdAmount ?? v.amount) : v);
  return Number.isFinite(n) ? n : null;
};

const pct = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
};

/** Chuẩn hoá 1 item của get_select_product_list → SheinProduct. */
export function normSelectItem(it: any): SheinProduct {
  const price = num(it.salePrice) ?? num(it.discountPrice) ?? num(it.retailPrice);
  const retail = num(it.retailPrice) ?? num(it.salePrice);
  const discountPct =
    price !== null && retail !== null && retail > 0 && price < retail
      ? Math.round((1 - price / retail) * 100)
      : num(it.unit_discount);
  const labels: string[] = [];
  const L = it.productInfoLabels;
  if (L && typeof L === "object") {
    for (const arr of Object.values(L)) {
      if (Array.isArray(arr)) {
        for (const l of arr) {
          const t = (l as any)?.labelLang || (l as any)?.labelLangEn || (l as any)?.label;
          if (t) labels.push(String(t));
        }
      }
    }
  }
  const gid = String(it.goods_id ?? "");
  const urlName = it.goods_url_name || it.goods_name || "";
  return {
    goodsId: gid,
    goodsSn: String(it.goods_sn ?? ""),
    spu: it.spu || it.productRelationID,
    name: it.goods_name ?? it.goods_url_name ?? "",
    image: httpsImg(it.goods_img || it.goodsColorImage || it.detail_image || it.goods_img_thumb),
    // URL sp: dựng chuẩn để autoCrawler mở lại được. SHEIN chấp nhận slug-cat_id-p-goodsId.html
    url: `https://us.shein.com/${String(urlName).replace(/\s+/g, "-")}-p-${gid}.html`,
    catId: it.cat_id ? String(it.cat_id) : undefined,
    catName: it.cate_name,
    storeCode: it.store_code ? String(it.store_code) : undefined,
    brandCode: it.brandCode,
    price,
    retailPrice: retail,
    discountPct,
    commentNum: Number(it.comment_num ?? 0) || 0,
    rating: num(it.comment_rank_average),
    labels,
    trueToSize: pct(it.percent_overall_fit?.true_size),
    isHighestSales: String(it.isHighestSales ?? "0") === "1",
    isLowestPrice: String(it.isLowestPrice ?? "0") === "1",
    soldOutStatus: Boolean(it.soldOutStatus),
    source: "shein-category",
  };
}

/** URL trang selection từ select_id (RecommendSelection, endpoint get_select_product_list).
 *  SHEIN cần dạng `<slug>-sc-<id>.html` — slug KHÔNG cần khớp tên (đã test: bất kỳ slug
 *  non-empty đều resolve). Thiếu slug (`sc-<id>.html`) → trang OOPS. */
export function categoryUrl(selectId: string): string {
  return `https://us.shein.com/RecommendSelection/category-sc-${selectId}.html?adp=`;
}

/** URL trang category THẬT từ cat_id (endpoint real_category_goods_list).
 *  Dạng `<slug>-c-<id>.html`. Dùng cho ngách granular (Bikini Sets, Shapewear, Bras…). */
export function catIdUrl(catId: string): string {
  return `https://us.shein.com/category-c-${catId}.html?adp=`;
}

/** Endpoint list SHEIN interceptable: selection (-sc-) + real category (-c-). */
const LIST_ENDPOINT_RE = /get_select_product_list|real_category_goods_list/;

export interface HarvestOpts {
  /** select_id ngách (vd "017172961") HOẶC full URL trang ngách. Bỏ qua nếu có catId. */
  selectId?: string;
  /** cat_id category thật (vd "1866" Bikini Sets). Ưu tiên hơn selectId nếu có. */
  catId?: string;
  cdpUrl: string;
  /** Trần số sp gom mỗi lần. Default 120 (đủ 1 lần load tự nhiên). */
  maxProducts?: number;
  /** Số lần cuộn tối đa để site tự kéo page kế (mỗi lần ~1 page). Default 0 = chỉ lấy batch đầu. */
  maxScrolls?: number;
  /** >0 = khi gặp captcha thì CHỜ người giải tay tối đa ms này (poll 3s) rồi chạy tiếp; 0 = dừng ngay. */
  captchaWaitMs?: number;
  onLog?: (m: string) => void;
}

export interface HarvestResult {
  selectId: string;
  products: SheinProduct[];
  total: number | null; // tổng sp ngách (field num) nếu đọc được
  pagesSeen: number;     // số response API bắt được
  captcha: boolean;      // true = dừng sớm vì risk/captcha
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readSsrProducts(page: Page): Promise<{ products: any[]; total: number | null }> {
  return page
    .evaluate(() => {
      try {
        const bpi = (window as any).gbRawData?.results?.bffProductsInfo;
        if (!bpi) return { products: [], total: null };
        return { products: Array.isArray(bpi.products) ? bpi.products : [], total: bpi.num ?? null };
      } catch {
        return { products: [], total: null };
      }
    })
    .catch(() => ({ products: [], total: null }));
}

async function isCaptcha(page: Page): Promise<boolean> {
  try {
    // risk/challenge = captcha giải được; risk/action(/limit) = rate-limit block cả phiên (nặng hơn).
    if (/risk\/challenge|risk\/action|captcha_type=/i.test(page.url())) return true;
    return await page.evaluate(() => !!document.querySelector('[class*="captcha"],[class*="challenge"]'));
  } catch {
    return false;
  }
}

/** Phân biệt rate-limit block (risk/action) với captcha thường (giải tay được). */
function isRateLimitBlock(page: Page): boolean {
  try { return /risk\/action/i.test(page.url()); } catch { return false; }
}

/**
 * Chờ người giải captcha tay tối đa waitMs (poll 3s). Giải xong (URL rời challenge) →
 * điều hướng lại về targetUrl để render list sạch. Trả true nếu đã qua captcha.
 */
async function waitManualCaptcha(page: Page, targetUrl: string, waitMs: number, log: (m: string) => void): Promise<boolean> {
  if (waitMs <= 0) return false;
  log(`✋ CAPTCHA — hãy giải tay trên cửa sổ Chrome. Chờ tối đa ${Math.round(waitMs / 1000)}s…`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await isCaptcha(page))) {
      log(`✅ Captcha đã qua → mở lại trang ngách.`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return !(await isCaptcha(page));
    }
  }
  log(`⌛ Hết giờ chờ giải captcha.`);
  return false;
}

/**
 * Gom sản phẩm 1 ngách. Trả những gì đã gom kể cả khi gặp captcha giữa chừng.
 * KHÔNG đóng Chrome (giữ phiên của user như autoCrawler).
 */
export async function harvestCategoryProducts(opts: HarvestOpts): Promise<HarvestResult> {
  const log = opts.onLog ?? (() => {});
  const maxProducts = opts.maxProducts ?? 120;
  const maxScrolls = opts.maxScrolls ?? 0;
  // catId (category thật) ưu tiên; rồi selectId (full URL giữ nguyên, hoặc dựng -sc-).
  const idLabel = opts.catId ? `c-${opts.catId}` : String(opts.selectId ?? "");
  const url = opts.catId
    ? catIdUrl(opts.catId)
    : /^https?:\/\//i.test(opts.selectId ?? "")
    ? (opts.selectId as string)
    : categoryUrl(String(opts.selectId ?? ""));
  if (!opts.catId && !opts.selectId) throw new Error("harvestCategoryProducts: cần selectId hoặc catId.");

  const browser: Browser = await chromium.connectOverCDP(opts.cdpUrl).catch((e: any) => {
    throw new Error(`Không connect Chrome CDP ${opts.cdpUrl} — mở Chrome --remote-debugging-port=9222. (${e?.message ?? e})`);
  });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();

  // Gom item từ MỌI response get_select_product_list mà SITE tự gọi (header anti-bot hợp lệ).
  const byId = new Map<string, SheinProduct>();
  let pagesSeen = 0;
  let total: number | null = null;

  const onResp = async (res: any) => {
    try {
      if (!LIST_ENDPOINT_RE.test(res.url())) return;
      const j = await res.json().catch(() => null);
      if (!j) return;
      const info = j.info || j;
      const prods: any[] = info?.products || [];
      if (info?.num != null && total == null) total = Number(info.num) || null;
      if (!prods.length) return; // rỗng = có thể bị chặn (code 836000)
      pagesSeen++;
      for (const raw of prods) {
        const p = normSelectItem(raw);
        if (/^\d{5,}$/.test(p.goodsId) && !byId.has(p.goodsId)) byId.set(p.goodsId, p);
      }
    } catch {
      /* bỏ qua response lỗi */
    }
  };
  page.on("response", onResp);

  let captcha = false;
  try {
    log(`🔎 Mở ngách ${idLabel} → ${url.slice(0, 70)}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);

    // Rate-limit block (risk/action) → giải tay KHÔNG qua, phải đợi phiên nguội → dừng ngay, báo rõ.
    if (isRateLimitBlock(page)) {
      captcha = true;
      log(`🛑 Ngách ${idLabel}: SESSION BỊ RATE-LIMIT BLOCK (risk/action/limit) — không phải hết trang. Đợi Chrome nguội vài phút / mở lại rồi chạy lại.`);
    } else if (await isCaptcha(page)) {
      // Captcha thường → chờ giải tay (nếu bật) rồi tiếp; không giải được thì dừng.
      const passed = await waitManualCaptcha(page, url, opts.captchaWaitMs ?? 0, log);
      if (!passed) {
        captcha = true;
        log(`🛑 Ngách ${idLabel}: dính captcha khi mở → dừng.`);
      }
    }

    if (captcha) {
      /* dừng */
    } else {
      // Nạp thêm từ SSR (gbRawData) — chắc chắn có kể cả khi response chưa parse kịp.
      const ssr = await readSsrProducts(page);
      if (ssr.total != null && total == null) total = ssr.total;
      for (const raw of ssr.products) {
        const p = normSelectItem(raw);
        if (/^\d{5,}$/.test(p.goodsId) && !byId.has(p.goodsId)) byId.set(p.goodsId, p);
      }
      // Chờ response đầu (site tự fetch page 1) ổn định.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

      // Sang page kế bằng CLICK NÚT SỐ (.sui-pagination). SHEIN category dùng PHÂN TRANG SỐ,
      // KHÔNG infinite-scroll — cuộn bao nhiêu cũng không kéo thêm. Mỗi click → site fetch
      // get_select_product_list?page=N (Playwright response listener bắt lại). maxScrolls =
      // số page kế cần lấy (2,3,…). Grid bị REPLACE mỗi trang nhưng byId gom từ API nên vẫn đủ.
      for (let i = 0; i < maxScrolls && byId.size < maxProducts; i++) {
        const targetPage = i + 2; // page 1 đã có
        const before = byId.size;
        const btn = page
          .locator(".sui-pagination button.sui-pagination__inner")
          .filter({ hasText: new RegExp(`^\\s*${targetPage}\\s*$`) })
          .first();
        if ((await btn.count().catch(() => 0)) === 0) {
          log(`   ⏹️ Không thấy nút page ${targetPage} (hết trang?) → dừng (${byId.size} sp).`);
          break;
        }
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(600 + Math.floor(Math.random() * 700)); // pacing người-hoá
        await btn.click().catch(() => {});
        // Chờ site fetch + render trang mới.
        await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
        await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
        if (await isCaptcha(page)) {
          const passed = await waitManualCaptcha(page, url, opts.captchaWaitMs ?? 0, log);
          if (!passed) {
            captcha = true;
            log(`🛑 Ngách ${idLabel}: captcha ở page ${targetPage} → dừng, giữ ${byId.size} sp đã gom.`);
            break;
          }
        }
        // Bổ sung từ SSR sau khi trang mới render (phòng response chưa parse kịp).
        const ssrN = await readSsrProducts(page);
        for (const raw of ssrN.products) {
          const p = normSelectItem(raw);
          if (/^\d{5,}$/.test(p.goodsId) && !byId.has(p.goodsId)) byId.set(p.goodsId, p);
        }
        if (byId.size - before <= 0) { log(`   ⏹️ Page ${targetPage} không thêm sp mới → dừng (${byId.size} sp).`); break; }
        log(`   ↳ page ${targetPage}: tổng gom ${byId.size} sp`);
      }
    }
  } catch (e: any) {
    log(`⚠️ Ngách ${idLabel} lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
  } finally {
    page.off("response", onResp);
    try { await page.close(); } catch { /* giữ Chrome mở */ }
  }

  const products = [...byId.values()].slice(0, maxProducts);
  log(`✓ Ngách ${idLabel}: gom ${products.length} sp (tổng ngách ~${total ?? "?"}, ${pagesSeen} batch)${captcha ? " [captcha]" : ""}`);
  return { selectId: idLabel, products, total, pagesSeen, captcha };
}
