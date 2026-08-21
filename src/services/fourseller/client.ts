/**
 * HTTP client 4Seller (bản rút gọn cho dripPublisher).
 * Cookie đọc từ data/cookies/<username>.json (hoặc accounts/<uid>.json khi principal="acct:<uid>")
 * — cùng layout với utils/configCookie. Chỉ 3 endpoint: list shop, list draft, batch-publish.
 */
import axios from "axios";
import fs from "fs-extra";
import path from "path";

const BASE_URL = "https://www.4seller.com";
const PER_USER_COOKIE_DIR = path.resolve(process.cwd(), "data", "cookies");

/** Đọc cookie file → Cookie header string (chỉ domain 4seller.com). */
async function getCookieHeader(principal: string): Promise<string> {
  let file: string;
  if (principal.startsWith("acct:")) {
    const uid = principal.slice(5).replace(/[^a-zA-Z0-9_-]/g, "");
    file = path.join(PER_USER_COOKIE_DIR, "accounts", `${uid}.json`);
    if (!(await fs.pathExists(file))) throw new Error(`Tài khoản 4Seller uid=${uid} chưa có cookie.`);
  } else {
    file = path.join(PER_USER_COOKIE_DIR, `${principal}.json`);
    if (!(await fs.pathExists(file))) throw new Error(`User "${principal}" chưa upload cookie 4Seller.`);
  }
  const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  const cookies: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  return cookies
    .filter((c) => String(c.domain || "").includes("4seller.com"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/web/listing/tiktok.html?type=tiktokActive`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

async function fourSellerPost<T = any>(username: string, pathSeg: string, body: any): Promise<T> {
  const cookieHeader = await getCookieHeader(username);
  const res = await axios.post(`${BASE_URL}${pathSeg}`, body, {
    headers: { ...COMMON_HEADERS, Cookie: cookieHeader },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`4Seller ${pathSeg} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  if (res.data?.code !== 0) {
    throw new Error(`4Seller ${pathSeg} error: ${res.data?.msg ?? res.data?.messages ?? "Unknown error"}`);
  }
  return res.data.data as T;
}

export interface FourSellerShop {
  id: number;
  platform?: string;
  shopName: string;
  status?: number;
}
export interface ListingRecord {
  id: number | string;
  productId: string;
  title?: string;
  publishStatus?: string;
  [k: string]: any;
}

export const getShopList = (username: string) =>
  fourSellerPost<{ records: FourSellerShop[]; total?: number }>(username, "/api/shop/get-tidy-list", {
    pageCurrent: 1,
    pageSize: 999,
  });

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

/** Publish 1+ draft theo listing id (POST mảng id thuần). */
export const batchPublish = (username: string, listingIds: (number | string)[]) =>
  fourSellerPost<any>(username, "/api/listing/tiktok/batch-publish", listingIds.map(Number));
