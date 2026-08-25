/**
 * Lấy danh sách shop ĐÃ LINK bên apps.kbt.global để đối chiếu với data local.
 *
 * Cấu hình qua file data/tikcrm/kbt.json (hoặc env), ví dụ:
 *   {
 *     "url": "https://apps.kbt.global/api/tikcheck/linked-shops",
 *     "authHeader": "X-Webhook-Secret",
 *     "authValue": "d6a2f0783741469ee1614154476e3966b73e9b64a5b1f6b422492e6dcf9e3714"
 *   }
 * (authHeader/authValue tùy chọn — bỏ trống nếu endpoint không cần auth.)
 *
 * Response chấp nhận linh hoạt: mảng string ["code1",...], mảng object
 * [{shop_id, shop_code}], hoặc {shops:[...]} / {data:[...]}. Set khớp cả
 * shop_id LẪN shop_code (chuẩn hoá về string).
 */
import fs from "fs-extra";
import path from "path";

const CFG_FILE = path.resolve(process.cwd(), "data", "tikcrm", "kbt.json");

export interface KbtConfig { url?: string; authHeader?: string; authValue?: string }

function loadConfig(): KbtConfig {
  // env ưu tiên (tiện deploy), fallback file
  const envUrl = process.env.TIKCRM_KBT_URL;
  if (envUrl) {
    return { url: envUrl, authHeader: process.env.TIKCRM_KBT_AUTH_HEADER, authValue: process.env.TIKCRM_KBT_AUTH_VALUE };
  }
  try { return fs.readJsonSync(CFG_FILE) as KbtConfig; } catch { return {}; }
}

const norm = (v: any) => String(v ?? "").trim();

/** Bới mọi shop_id / shop_code trong response bất kể cấu trúc. */
function extractIds(data: any): string[] {
  const out: string[] = [];
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.shops) ? data.shops
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.records) ? data.records
    : [];
  for (const it of arr) {
    if (it == null) continue;
    if (typeof it === "string" || typeof it === "number") { out.push(norm(it)); continue; }
    // CHỈ match theo shop_id / shop_code (KHÔNG lấy "id" nội bộ của apps.kbt để tránh trùng nhầm)
    for (const k of ["shop_id", "shop_code", "shopId", "shopCode"]) {
      if (it[k] != null && it[k] !== "") out.push(norm(it[k]));
    }
  }
  return out.filter(Boolean);
}

export interface LinkedResult {
  configured: boolean;
  ok: boolean;
  set: Set<string>;
  count: number;
  error?: string;
  fetchedAt: number;
}

let cache: LinkedResult | null = null;
const TTL = 5 * 60_000;

export async function getLinkedShops(force = false): Promise<LinkedResult> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL) return cache;
  const cfg = loadConfig();
  if (!cfg.url) {
    // KHÔNG cache trạng thái chưa cấu hình → vừa tạo kbt.json là lần gọi sau ăn ngay
    return { configured: false, ok: false, set: new Set(), count: 0, error: "chưa cấu hình data/tikcrm/kbt.json", fetchedAt: Date.now() };
  }
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.authHeader && cfg.authValue) headers[cfg.authHeader] = cfg.authValue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(cfg.url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = extractIds(data);
    cache = { configured: true, ok: true, set: new Set(ids), count: new Set(ids).size, fetchedAt: Date.now() };
    return cache;
  } catch (e: any) {
    // lỗi mạng → giữ cache cũ nếu có (tránh mất cột), nếu không thì báo lỗi
    if (cache && cache.ok) return { ...cache, error: `refresh lỗi: ${e?.message ?? e}` };
    cache = { configured: true, ok: false, set: new Set(), count: 0, error: e?.message ?? String(e), fetchedAt: Date.now() };
    return cache;
  }
}

/** true = đã có bên apps.kbt, false = chưa có, null = không xác định (chưa cấu hình / lỗi). */
export function isLinked(result: LinkedResult, shopId: any, shopCode: any): boolean | null {
  if (!result.configured || !result.ok) return null;
  return result.set.has(norm(shopId)) || result.set.has(norm(shopCode));
}
