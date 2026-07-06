/**
 * HTTP client cho 4Seller API. Dùng cookie của user (đã upload qua Admin UI)
 * để authenticated request.
 *
 * Endpoints đã tìm được:
 *  - POST /api/shop/get-tidy-list                  → list shops account này có
 *  - POST /api/listing/get-status-count            → đếm listings theo status
 *  - POST /api/listing/tiktok/page                 → paginate listings
 */
import axios from "axios";
import fs from "fs-extra";
import path from "path";

const BASE_URL = "https://www.4seller.com";
const PER_USER_COOKIE_DIR = path.resolve(process.cwd(), "data", "cookies");

/**
 * Read raw cookie file và convert sang Cookie header string.
 * principal:
 *  - "acct:<uid>"  → cookie của TÀI KHOẢN 4Seller (data/cookies/accounts/<uid>.json) — cơ chế mới
 *  - "<username>"  → cookie legacy theo login user (data/cookies/<username>.json)
 */
async function getCookieHeader(principal: string): Promise<string> {
  let file: string;
  if (principal.startsWith("acct:")) {
    const uid = principal.slice(5).replace(/[^a-zA-Z0-9_-]/g, "");
    file = path.join(PER_USER_COOKIE_DIR, "accounts", `${uid}.json`);
    if (!(await fs.pathExists(file))) {
      throw new Error(`Tài khoản 4Seller uid=${uid} chưa có cookie (tab Cookie 4Seller).`);
    }
  } else {
    file = path.join(PER_USER_COOKIE_DIR, `${principal}.json`);
    if (!(await fs.pathExists(file))) {
      throw new Error(`User "${principal}" chưa upload cookie 4Seller.`);
    }
  }
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  const cookies: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
    ? parsed.cookies
    : [];

  // Chỉ pick cookies thuộc domain 4seller.com
  const relevant = cookies.filter((c) => {
    const domain = String(c.domain || "");
    return domain.includes("4seller.com");
  });

  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/web/listing/tiktok.html?type=tiktokActive`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

async function fourSellerPost<T = any>(
  username: string,
  pathSeg: string,
  body: any,
  opts?: { form?: boolean }
): Promise<T> {
  const cookieHeader = await getCookieHeader(username);
  const isForm = !!opts?.form;
  const payload = isForm
    ? new URLSearchParams(body).toString()
    : body;
  const contentType = isForm ? "application/x-www-form-urlencoded" : "application/json";
  try {
    const res = await axios.post(`${BASE_URL}${pathSeg}`, payload, {
      headers: { ...COMMON_HEADERS, "Content-Type": contentType, Cookie: cookieHeader },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      throw new Error(`4Seller ${pathSeg} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    if (res.data?.code !== 0) {
      const msg = res.data?.msg ?? res.data?.messages ?? "Unknown error";
      throw new Error(`4Seller ${pathSeg} error: ${msg}`);
    }
    return res.data.data as T;
  } catch (err: any) {
    if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
      throw new Error(`4Seller ${pathSeg} timeout`);
    }
    throw err;
  }
}

async function fourSellerGet<T = any>(
  username: string,
  pathSeg: string
): Promise<T> {
  const cookieHeader = await getCookieHeader(username);
  try {
    const res = await axios.get(`${BASE_URL}${pathSeg}`, {
      headers: { ...COMMON_HEADERS, Cookie: cookieHeader },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      throw new Error(`4Seller ${pathSeg} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    if (res.data?.code !== 0) {
      const msg = res.data?.msg ?? res.data?.messages ?? "Unknown error";
      throw new Error(`4Seller ${pathSeg} error: ${msg}`);
    }
    return res.data.data as T;
  } catch (err: any) {
    if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
      throw new Error(`4Seller ${pathSeg} timeout`);
    }
    throw err;
  }
}

/* ============= Domain types ============= */

export interface FourSellerShop {
  id: number;
  platform: string;
  shopName: string;
  platformShopName: string;
  region?: string;
  marketplaceId?: string;
  site?: string;
  sellingPartnerId?: string;
  status?: number;
  statusDesc?: string;
}

export interface ShopStatusCount {
  activeCount: number;
  inactiveCount: number;
  removedCount: number;
  suspendedCount: number;
  incompleteCount?: number;
  privateCount?: number;
  pendingCount?: number;
  rejectCount?: number;
  unsaleableCount?: number;
}

export interface ListingRecord {
  id: number | string;
  productId: string;
  title?: string;
  // ... 4Seller trả nhiều field, ta giữ flexible
  [k: string]: any;
}

/* ============= API wrappers ============= */

export const getShopList = (username: string) =>
  fourSellerPost<{ records: FourSellerShop[]; total?: number }>(
    username,
    "/api/shop/get-tidy-list",
    { pageCurrent: 1, pageSize: 999 }
  );

export const getStatusCount = (
  username: string,
  opts?: { shopId?: string | number; platform?: string }
) =>
  fourSellerPost<ShopStatusCount>(username, "/api/listing/get-status-count", {
    shopId: opts?.shopId ?? null,
    queryStatus: "",
    sitePublishStatus: "",
    searchType: "msku",
    searchValue: [],
    searchMethod: "exact",
    groupId: "",
    migrationPageType: "q-all",
    listingIdList: [],
    isGlobal: null,
    erpStatus: "",
    platform: opts?.platform ?? "tiktok",
    hasVariation: "",
    stock: null,
  });

/**
 * Lấy chi tiết 1 listing. CHÚ Ý: endpoint dùng form-urlencoded, không phải JSON.
 *
 * Response chứa: id, shopId, shopName, productId, categoryId, brandId, productName,
 *   description, attributes, variants (qty/price/sku), images, ...
 */
export const getListingDetail = (
  username: string,
  listingId: string | number
) =>
  fourSellerPost<any>(
    username,
    "/api/listing/tiktok/detail",
    { listingId: String(listingId) },
    { form: true }
  );

export interface CategoryInfo {
  categoryId: string;
  categoryName: string;
  nodePath: string;
  nodePathId: string;
  categoryParentId?: string;
}

export const getCategoryById = (
  username: string,
  categoryId: string,
  site: string,
  shopId: string | number
) =>
  fourSellerGet<CategoryInfo>(
    username,
    `/api/meta/tiktok/get-category-by-id?categoryId=${encodeURIComponent(categoryId)}&site=${encodeURIComponent(site)}&shopId=${encodeURIComponent(String(shopId))}`
  );

/** Lấy DRAFT của 1 shop (status="draft"). shopId = id số từ getShopList. */
export const getDraftPage = (
  username: string,
  opts: { shopId?: string | number; pageCurrent?: number; pageSize?: number }
) =>
  fourSellerPost<{ records: ListingRecord[]; total: number }>(username, "/api/listing/tiktok/page", {
    pageCurrent: opts.pageCurrent ?? 1,
    pageSize: opts.pageSize ?? 100,
    isGlobal: null,
    suspendedStatus: "",
    status: "draft",
    orderBy: "update_time",
    desc: "desc",
    shopId: opts.shopId ?? "",
    queryStatus: "",
    sitePublishStatus: "",
    searchType: "msku",
    searchValue: [],
    searchMethod: "exact",
    groupId: "",
    migrationPageType: "q-all",
    listingIdList: [],
    hasVariation: "",
    categoryMap: [""],
  });

/** Publish 1 hoặc nhiều draft theo listing id (POST mảng id thuần). */
export const batchPublish = (username: string, listingIds: (number | string)[]) =>
  fourSellerPost<any>(username, "/api/listing/tiktok/batch-publish", listingIds.map(Number));

/** 1 dòng báo cáo doanh số theo shop (endpoint Report → Sales by shop). */
export interface ShopSalesRow {
  shopId: number;
  shopName: string;
  platform: string;
  totalSales: number;
  paidSales: number;
  refundedSales: number;
  totalOrders: number;
  paidOrders: number;
  averageOrderValue: number;
}

/**
 * Doanh số/đơn theo từng shop trong khoảng [startTime, endTime] (YYYY-MM-DD).
 * shopIds = mảng id số (từ getShopList). CHỈ trả shop có phát sinh đơn trong kỳ.
 */
export const getSalesByShop = (
  username: string,
  opts: { startTime: string; endTime: string; shopIds: (number | string)[] }
) =>
  fourSellerPost<ShopSalesRow[]>(username, "/api/shop-sales-performance/shop-list", {
    desc: "desc",
    orderBy: "total_sales",
    startTime: opts.startTime,
    endTime: opts.endTime,
    shopIds: opts.shopIds,
  });

/* ============= Category tree (TikTok) ============= */

export interface CategoryNode {
  categoryId: string;
  categoryParentId: string;
  categoryName: string;
  nodePath: string;      // "Sports & Outdoor/Ball Sports/..."
  leafCategory: number;  // 1 = leaf (chọn được), 0 = còn con
  supportSizeChart?: number;
}

/** Lấy các category CON trực tiếp của parentId (0 = root). shopId bắt buộc (bất kỳ shop nào). */
export const getCategoryList = (
  principal: string,
  parentId: string | number,
  shopId: string | number,
  site = "US"
) =>
  fourSellerPost<CategoryNode[]>(principal, "/api/meta/tiktok/get-category-list", {
    site,
    parentId,
    shopId,
  });

/* ============= Marketing / Promotions (TikTok) ============= */

export interface PromotionActivity {
  id: number;
  shopId: number;
  shopName: string;
  platformActivityId: string;
  activityName: string;
  discountType: "DIRECT_DISCOUNT" | "FLASHSALE" | string;
  beginTime: number; // epoch ms
  endTime: number;   // epoch ms
  promotionStatus: "ONGOING" | "NOT_START" | string; // hết hạn = status khác (EXPIRED/END)
  productLevel: string;
  productCount: number;
  productFailCount: number;
  errorMessage?: string;
}

/** List promotion (Marketing → Product Discount / Flash Deal). discountType rỗng = cả 2 loại. */
export const getPromotionPage = (
  principal: string,
  opts?: {
    discountType?: "" | "DIRECT_DISCOUNT" | "FLASHSALE";
    shopId?: string | number;
    promotionStatus?: string;
    pageCurrent?: number;
    pageSize?: number;
  }
) =>
  fourSellerPost<{ records: PromotionActivity[]; total?: number }>(
    principal,
    "/api/promotion/tiktok/activity/get-page",
    {
      pageCurrent: opts?.pageCurrent ?? 1,
      pageSize: opts?.pageSize ?? 100,
      discountType: opts?.discountType ?? "",
      shopId: opts?.shopId ?? "",
      promotionStatus: opts?.promotionStatus ?? "",
      searchType: "activityName",
      searchValue: "",
    }
  );

/** Trigger sync promotion từ TikTok (nút "Sync promotion" trên UI). shopId rỗng = All Shop. */
export const syncTiktokPromotions = (principal: string, shopId: string | number = "") =>
  fourSellerGet<boolean>(
    principal,
    `/api/promotion/tiktok/activity/sync-tiktok-activity?shopId=${encodeURIComponent(String(shopId))}`
  );

/** Sync đang chạy? true = đang sync (poll đến khi false là data mới sẵn sàng). */
export const getPromotionSyncSchedule = (principal: string) =>
  fourSellerGet<boolean>(principal, "/api/promotion/tiktok/activity/get-sync-schedule");

export const getListingPage = (
  username: string,
  opts: {
    shopId?: string | number;
    status?: "active" | "inactive" | "removed" | "suspended";
    pageCurrent?: number;
    pageSize?: number;
  }
) =>
  fourSellerPost<{ records: ListingRecord[]; total: number }>(
    username,
    "/api/listing/tiktok/page",
    {
      pageCurrent: opts.pageCurrent ?? 1,
      pageSize: opts.pageSize ?? 50,
      isGlobal: null,
      suspendedStatus: "",
      status: opts.status ?? "active",
      orderBy: "update_time",
      desc: "desc",
      shopId: opts.shopId ?? "",
      queryStatus: "",
      sitePublishStatus: "",
      searchType: "msku",
      searchValue: [],
      searchMethod: "exact",
      groupId: "",
    }
  );
