/**
 * Client cho 2 RapidAPI SHEIN, chuẩn hoá về 1 kiểu chung.
 *
 *  - shein-data-api (belchiorarkad): engine khám phá (search/v2, bycategory/best,
 *    categories, recommended). Item search có sẵn tín hiệu win (comment_num, rating).
 *  - shein-online-data (sheindata): engine detail ổn định + search dự phòng.
 *    Plan rate-limit theo GIÂY → cần throttle.
 *
 * getProductDetail() tự fallback: thử shein-online-data trước (ổn định), nếu lỗi
 * thử shein-data-api.
 */
import axios from "axios";
import { config } from "../../config";
import type {
  SheinProduct,
  SheinProductDetail,
  SheinSearchResult,
} from "./types";

const HOST_DATA = "shein-data-api.p.rapidapi.com";
const HOST_ONLINE = "shein-online-data.p.rapidapi.com";

/**
 * Tier-3 detail fallback: "Shein API V1" (YemenAD) — API Shein tươi nhất hub
 * (update liên tục, 100% SL, 5-10 rps) nhưng CHỈ có product detail (không search).
 * Khảo sát 2026-08-07: https://rapidapi.com/yemenad-yemenad-default/api/shein-api-v1
 *
 * ⚠️ BẬT SAU KHI SUBSCRIBE + XÁC NHẬN PATH: RapidAPI hub là SPA — path endpoint chính
 * xác phải xem trong playground sau khi subscribe. Cấu hình qua env:
 *   SHEIN_API_V1_ENABLED=1
 *   SHEIN_API_V1_DETAIL_PATH=/productDetail-v3?goods_id={goodsId}&country={country}
 * ({goodsId} + {country} là placeholder được thay lúc gọi). Chưa bật = tier-3 im lặng
 * bỏ qua, 2 tier cũ chạy như trước.
 */
const HOST_V1 = "shein-api-v1.p.rapidapi.com";
const v1Enabled = () => (process.env.SHEIN_API_V1_ENABLED ?? "").trim() === "1";
const v1DetailPath = (goodsId: string, country: string): string => {
  const tpl = (process.env.SHEIN_API_V1_DETAIL_PATH ?? "/productDetail-v3?goods_id={goodsId}&country={country}").trim();
  return tpl
    .replace("{goodsId}", encodeURIComponent(goodsId))
    .replace("{country}", encodeURIComponent(country));
};

/** shein-online-data /api/search từ chối limit > 20 (HTTP 400). Clamp để fallback không vỡ. */
const ONLINE_SEARCH_MAX_LIMIT = 20;

/** Throttle tối thiểu giữa 2 request CÙNG host (ms). shein-online-data limit/giây. */
const MIN_INTERVAL: Record<string, number> = {
  [HOST_ONLINE]: 1500,
  [HOST_DATA]: 1200, // plan rate-limit theo giây → giữ dưới ~1 req/s tránh 429
  [HOST_V1]: 250,    // YemenAD Pro 5 rps / Ultra 10 rps — 250ms an toàn cho Pro
};
const lastCallAt: Record<string, number> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(host: string) {
  const min = MIN_INTERVAL[host] ?? 0;
  const last = lastCallAt[host] ?? 0;
  const wait = last + min - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt[host] = Date.now();
}

async function apiGet<T = any>(
  host: string,
  path: string,
  opts?: { maxAttempts?: number; timeout?: number }
): Promise<T> {
  if (!config.rapidApiKey) {
    throw new Error("RAPIDAPI_KEY chưa cấu hình trong .env");
  }
  // Provider chập chờn (429 / timeout / 5xx) → retry với backoff.
  const MAX_ATTEMPTS = opts?.maxAttempts ?? 2;
  const TIMEOUT = opts?.timeout ?? 15000;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle(host);
    try {
      const res = await axios.get(`https://${host}${path}`, {
        headers: { "x-rapidapi-key": config.rapidApiKey, "x-rapidapi-host": host },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (res.status === 200) return res.data as T;
      // 429 / 5xx → đáng retry
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1200 * attempt);
          continue;
        }
      }
      const msg =
        (res.data && (res.data.message || res.data.error?.message)) || `HTTP ${res.status}`;
      throw new Error(`SHEIN ${path} → ${msg}`);
    } catch (e: any) {
      const isTimeout = e?.code === "ECONNABORTED" || /timeout/i.test(e?.message ?? "");
      if (isTimeout && attempt < MAX_ATTEMPTS) {
        lastErr = "timeout";
        await sleep(1000 * attempt);
        continue;
      }
      if (e?.message?.startsWith("SHEIN ")) throw e;
      if (attempt >= MAX_ATTEMPTS) throw new Error(`SHEIN ${path} → ${lastErr || e?.message || "lỗi"}`);
    }
  }
  throw new Error(`SHEIN ${path} → ${lastErr || "thất bại sau retry"}`);
}

/* ─────────── Helpers chuẩn hoá ─────────── */

const httpsImg = (u?: string | null): string => {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
};

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? v.amount ?? v.usdAmount : v);
  return Number.isFinite(n) ? n : null;
};

/** Chuẩn hoá 1 item search của shein-data-api → SheinProduct. */
function normDataApiItem(it: any): SheinProduct {
  const price = num(it.salePrice) ?? num(it.discountPrice) ?? num(it.retailPrice);
  const retail = num(it.retailPrice) ?? num(it.salePrice);
  const discountPct =
    price !== null && retail !== null && retail > 0 && price < retail
      ? Math.round((1 - price / retail) * 100)
      : num(it.unit_discount);
  const labels: string[] = [];
  if (Array.isArray(it.productInfoLabels)) {
    for (const l of it.productInfoLabels) {
      const t = l?.labelLang || l?.label || l?.text;
      if (t) labels.push(String(t));
    }
  }
  return {
    goodsId: String(it.goods_id ?? ""),
    goodsSn: String(it.goods_sn ?? ""),
    spu: it.spu || it.productRelationID,
    name: it.goods_name ?? it.goods_url_name ?? "",
    image: httpsImg(it.goods_img || it.goodsColorImage || it.detail_image),
    url: it.productUrl,
    catId: it.cat_id ? String(it.cat_id) : undefined,
    catName: it.cate_name,
    storeCode: it.store_code ? String(it.store_code) : undefined,
    brandCode: it.brandCode,
    price,
    retailPrice: retail,
    discountPct,
    commentNum: Number(it.comment_num ?? it.comment_num_show ?? 0) || 0,
    rating: num(it.comment_rank_average),
    labels,
    source: "shein-data-api",
  };
}

/** Chuẩn hoá 1 item search của shein-online-data → SheinProduct. */
function normOnlineItem(it: any): SheinProduct {
  const price = num(it.salePrice ?? it.sale_price ?? it.price);
  const retail = num(it.retailPrice ?? it.retail_price ?? it.original_price);
  const discountPct =
    price !== null && retail !== null && retail > 0 && price < retail
      ? Math.round((1 - price / retail) * 100)
      : null;
  return {
    goodsId: String(it.goods_id ?? it.product_id ?? ""),
    goodsSn: String(it.goods_sn ?? ""),
    spu: it.spu || it.productRelationID,
    name: it.goods_name ?? "",
    image: httpsImg(it.goods_img || it.image),
    catName: it.category_name,
    storeCode: it.store_code ? String(it.store_code) : undefined,
    price,
    retailPrice: retail,
    discountPct,
    commentNum: Number(it.comment_num ?? 0) || 0,
    rating: num(it.comment_rank_average ?? it.rating),
    labels: [],
    source: "shein-online-data",
  };
}

/** Lấy mảng products từ response shein-data-api (linh hoạt vị trí). */
function extractDataApiProducts(d: any): any[] {
  return (
    d?.products ||
    d?.data?.products ||
    d?.data?.goods ||
    d?.data?.list ||
    (Array.isArray(d?.data) ? d.data : []) ||
    []
  );
}

/* ─────────── API công khai ─────────── */

/** Search shein-online-data (dự phòng — item ít tín hiệu win hơn: không có review/rating). */
async function searchProductsOnline(
  query: string,
  opts: { page?: number; perPage?: number; country?: string } = {}
): Promise<SheinSearchResult> {
  const page = opts.page ?? 1;
  // Endpoint trả 400 nếu limit > 20 → clamp. hasNext tính theo limit THỰC (không phải perPage yêu cầu).
  const limit = Math.min(opts.perPage ?? 40, ONLINE_SEARCH_MAX_LIMIT);
  const country = (opts.country ?? "US").toUpperCase();
  const d = await apiGet(
    HOST_ONLINE,
    `/api/search?country=${country}&keywords=${encodeURIComponent(query)}&currency=USD&page=${page}&limit=${limit}&lang=en`
  );
  const info = d?.info?.info ?? d?.info ?? d;
  const items: any[] = info?.products ?? [];
  const products = items.map(normOnlineItem);
  const total = Number(info?.total_count ?? products.length) || products.length;
  return { products, total, page, hasNext: products.length >= limit };
}

/**
 * Search theo keyword. Ưu tiên shein-data-api (có review/rating → winScore tốt);
 * nếu lỗi/timeout (provider chập chờn) → tự fallback sang shein-online-data.
 */
export async function searchProducts(
  query: string,
  opts: { page?: number; perPage?: number; country?: string } = {}
): Promise<SheinSearchResult & { source: "shein-data-api" | "shein-online-data" }> {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 40;
  const country = (opts.country ?? "us").toLowerCase();
  // PRIMARY = shein-online-data (đang sống). shein-data-api /search/v2 đang treo (nghi provider
  // đổi/gỡ endpoint) → hạ xuống fallback: chỉ chạm khi online lỗi, và tự dùng lại NGAY khi
  // data-api hồi phục (nguồn này có review/rating → winScore mạnh hơn).
  try {
    const fb = await searchProductsOnline(query, opts);
    if (fb.products.length === 0) throw new Error("online-data trả rỗng");
    return { ...fb, source: "shein-online-data" };
  } catch {
    const d = await apiGet(
      HOST_DATA,
      `/search/v2?query=${encodeURIComponent(query)}&page=${page}&perPage=${perPage}&countryCode=${country}`,
      { maxAttempts: 1, timeout: 4000 }
    );
    const products = extractDataApiProducts(d).map(normDataApiItem);
    return {
      products,
      total: Number(d?.pagination?.totalAvailable ?? products.length) || products.length,
      page,
      hasNext: Boolean(d?.pagination?.hasNext),
      source: "shein-data-api",
    };
  }
}

/** Best-selling theo SHEIN categoryId (shein-data-api). */
export async function bestSellersByCategory(
  categoryId: string,
  opts: { page?: number; perPage?: number; country?: string } = {}
): Promise<SheinSearchResult> {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 20;
  const country = (opts.country ?? "us").toLowerCase();
  const d = await apiGet(
    HOST_DATA,
    `/product/bycategory/best?categoryId=${encodeURIComponent(categoryId)}&countryCode=${country}&page=${page}&perPage=${perPage}`
  );
  const products = extractDataApiProducts(d).map(normDataApiItem);
  return { products, total: products.length, page, hasNext: products.length >= perPage };
}

/** Sản phẩm tương tự 1 goodsId (shein-data-api). */
export async function recommendedProducts(
  goodsId: string,
  opts: { limit?: number; country?: string } = {}
): Promise<SheinProduct[]> {
  const limit = opts.limit ?? 20;
  const country = (opts.country ?? "US");
  const d = await apiGet(
    HOST_DATA,
    `/product/recommended?goodsId=${encodeURIComponent(goodsId)}&limit=${limit}&countryCode=${country}`
  );
  return extractDataApiProducts(d).map(normDataApiItem);
}

/** Cây category SHEIN (shein-data-api). */
export async function getCategories(country = "us"): Promise<any[]> {
  const d = await apiGet(HOST_DATA, `/categories?countryCode=${country.toLowerCase()}`);
  return d?.data ?? [];
}

/** Keyword/ngách top của 1 store SHEIN (shein-data-api). */
export async function getStoreKeywords(
  storeCode: string,
  country = "us"
): Promise<string[]> {
  const d = await apiGet(
    HOST_DATA,
    `/store/keywords?storeCode=${encodeURIComponent(storeCode)}&lang=en&country=${country.toLowerCase()}`
  );
  const kws = d?.data?.keywords;
  if (!Array.isArray(kws)) return [];
  return kws.map((k: any) => k?.word).filter((w: any): w is string => Boolean(w));
}

/** Tổng số sp + URL của 1 store (shein-data-api). */
export async function getStoreQuantity(
  storeCode: string,
  country = "us"
): Promise<{ quantity: number | null; storeUrl: string | null }> {
  const d = await apiGet(
    HOST_DATA,
    `/store/products/quantity?storeCode=${encodeURIComponent(storeCode)}&country=${country.toLowerCase()}`
  );
  return {
    quantity: typeof d?.data?.quantity === "number" ? d.data.quantity : null,
    storeUrl: d?.data?.storeUrl ?? null,
  };
}

/** Detail 1 sản phẩm — ưu tiên shein-online-data (ổn định), fallback shein-data-api. */
export async function getProductDetail(
  goodsId: string,
  opts: { goodsSn?: string; country?: string } = {}
): Promise<SheinProductDetail> {
  const country = (opts.country ?? "US");
  // 1. shein-online-data /api/product/{goodsId}
  try {
    const d = await apiGet(
      HOST_ONLINE,
      `/api/product/${encodeURIComponent(goodsId)}?lang=en&currency=USD&country=${country}`
    );
    const info = d?.info?.info ?? d?.info ?? d;
    if (info && (info.goods_id || info.goods_name)) {
      return normOnlineDetail(info);
    }
  } catch {
    // thử nguồn 2
  }
  // 2. shein-data-api fallback (bygoodsid)
  try {
    const d2 = await apiGet(
      HOST_DATA,
      `/product/description/bygoodsid?goods_id=${encodeURIComponent(goodsId)}&country=${country.toLowerCase()}`
    );
    const data = d2?.data;
    if (data) return normDataApiDetail(data, goodsId, opts.goodsSn);
  } catch {
    // thử tier 3 nếu bật
  }
  // 3. Shein API V1 (YemenAD) — tier-3, chỉ khi SHEIN_API_V1_ENABLED=1 (xem chú thích HOST_V1).
  if (v1Enabled()) {
    const d3 = await apiGet(HOST_V1, v1DetailPath(goodsId, country), { maxAttempts: 2, timeout: 12000 });
    const info = d3?.data ?? d3?.info?.info ?? d3?.info ?? d3?.product ?? d3;
    if (info && (info.goods_id || info.goods_name || info.productName)) {
      return normDataApiDetail(info, goodsId, opts.goodsSn);
    }
  }
  throw new Error(
    `Không lấy được detail từ ${v1Enabled() ? "cả 3" : "cả 2"} API (có thể endpoint đang bảo trì)`
  );
}

function normOnlineDetail(info: any): SheinProductDetail {
  const priceSummary = info.price_and_stock_summary || info.price || {};
  const price =
    num(priceSummary.sale_price ?? priceSummary.salePrice ?? priceSummary.price) ??
    num(info.salePrice);
  const retail = num(priceSummary.retail_price ?? priceSummary.retailPrice);
  const images: string[] = Array.isArray(info.all_images)
    ? info.all_images.map((x: any) => httpsImg(typeof x === "string" ? x : x?.url || x?.image))
    : [];
  const main = httpsImg(info.main_image || images[0]);
  const attributes = Array.isArray(info.attribute)
    ? info.attribute.map((a: any) => ({
        name: String(a.attr_name ?? a.name ?? "").trim(),
        value: String(a.attr_value ?? a.value ?? "").trim(),
      }))
    : [];
  const material = Array.isArray(info.material_details)
    ? info.material_details.map((a: any) => ({
        name: String(a.attr_name ?? "").trim(),
        value: String(a.attr_value ?? "").trim(),
      }))
    : [];
  const relatedColors = Array.isArray(info.related_colors)
    ? info.related_colors.map((c: any) => ({
        goodsId: String(c.goods_id ?? ""),
        image: httpsImg(c.goods_img || c.image),
      }))
    : [];
  return {
    goodsId: String(info.goods_id ?? ""),
    goodsSn: String(info.goods_sn ?? info.SKU ?? ""),
    name: info.goods_name ?? "",
    catName: info.category_name,
    storeCode: info.store_code ? String(info.store_code) : undefined,
    price,
    retailPrice: retail,
    mainImage: main,
    images: images.filter(Boolean),
    attributes,
    material,
    relatedColors,
    source: "shein-online-data",
    raw: info,
  };
}

function normDataApiDetail(data: any, goodsId: string, goodsSn?: string): SheinProductDetail {
  const images: string[] = Array.isArray(data.images || data.detail_image)
    ? (data.images || data.detail_image).map((x: any) => httpsImg(typeof x === "string" ? x : x?.url))
    : [];
  return {
    goodsId: String(data.goods_id ?? goodsId),
    goodsSn: String(data.goods_sn ?? goodsSn ?? ""),
    name: data.goods_name ?? data.productName ?? "",
    price: num(data.salePrice ?? data.price),
    retailPrice: num(data.retailPrice),
    mainImage: httpsImg(data.goods_img || images[0]),
    images: images.filter(Boolean),
    attributes: [],
    material: [],
    relatedColors: [],
    description: data.description,
    source: "shein-data-api",
    raw: data,
  };
}
