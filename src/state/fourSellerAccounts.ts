/**
 * Quản lý NHIỀU tài khoản 4Seller (mỗi tài khoản chỉ import được ~30 shop).
 *
 * Thiết kế thay cho cơ chế cũ "cookie theo login user" (admin/tuananh):
 *  - Paste/kéo file cookie export vào → tự detect tài khoản qua cookie `uid`
 *    (mỗi tài khoản 4Seller có uid riêng, file export nào cũng chứa).
 *  - Cookie lưu ở data/cookies/accounts/<uid>.json + registry index.json giữ
 *    label ("Tài khoản 1/2...") và danh sách shop của tài khoản (sync từ
 *    /api/shop/get-tidy-list).
 *  - Worker resolve cookie THEO SHOP: shop folder thuộc tài khoản nào thì dùng
 *    cookie tài khoản đó — không còn phụ thuộc user đăng nhập nào đã paste.
 */
import crypto from "crypto";
import path from "path";
import fs from "fs-extra";
import { getShopList } from "../services/fourseller/client";

const ACCOUNTS_DIR = path.resolve(process.cwd(), "data", "cookies", "accounts");
const INDEX_FILE = path.join(ACCOUNTS_DIR, "index.json");

export interface FourSellerAccount {
  /** uid từ cookie 4Seller — định danh tài khoản. */
  uid: string;
  /** Nhãn hiển thị: "Tài khoản 1", "Tài khoản 2"... (đổi được). */
  label: string;
  /** Email 4Seller — có khi đăng nhập qua auto-login (user gõ). Dễ nhận biết hơn label. */
  email?: string;
  /** Danh sách shopName thật từ 4Seller (sync qua get-tidy-list). */
  shops: string[];
  cookieCount: number;
  cookieUpdatedAt: number;
  shopsUpdatedAt: number;
}

interface AccountsIndex {
  accounts: FourSellerAccount[];
}

/**
 * Chuẩn hoá tên shop để match folder ↔ shopName 4Seller.
 * Bỏ đuôi thị trường `_US`/`_DE`/`_UK`… (nguồn gây "không thấy shop" khi 1 bên có đuôi,
 * bên kia không) + bỏ space & mọi loại gạch + lowercase → 2 tên khác đuôi vẫn khớp.
 */
// Bỏ luôn ký tự cấm trong tên thư mục Windows (/ \ : * ? " < > |): shop 4Seller "TN Scan 12/07 - 33-…"
// lưu trên đĩa thành "TN Scan 12-07 - 33-…" vẫn phải khớp (đo 25/09: 2 shop không nối được → 0 listing).
export const normShopName = (s: string): string =>
  (s || "").toLowerCase().trim().replace(/_[a-z]{2}$/, "").replace(/[\s—–\-\\/:*?"<>|]+/g, "");

const readIndex = async (): Promise<AccountsIndex> => {
  try {
    const idx = await fs.readJson(INDEX_FILE);
    if (Array.isArray(idx?.accounts)) return idx;
  } catch {
    /* chưa có */
  }
  return { accounts: [] };
};

const writeIndex = async (idx: AccountsIndex): Promise<void> => {
  await fs.ensureDir(ACCOUNTS_DIR);
  await fs.writeJson(INDEX_FILE, idx, { spaces: 2 });
};

/** Path file cookie của 1 tài khoản. */
export const accountCookiePath = (uid: string): string => {
  // uid từ cookie là chuỗi số; sanitize để không thành path traversal.
  const safe = String(uid).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(ACCOUNTS_DIR, `${safe}.json`);
};

/** Nhận raw parse từ file export (array hoặc {cookies:[...]}) → array cookie. */
export const normalizeCookieArray = (parsed: any): any[] => {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.cookies)) return parsed.cookies;
  return [];
};

/**
 * Định danh tài khoản từ mảng cookie: ưu tiên cookie `uid`; file export cũ
 * không có uid → fallback hash userToken (vẫn ổn định theo phiên đăng nhập).
 */
export const extractAccountUid = (cookies: any[]): string | null => {
  const uid = cookies.find((c) => c?.name === "uid")?.value;
  if (uid) return String(uid);
  const token = cookies.find((c) => c?.name === "userToken")?.value;
  if (token) return `tk-${crypto.createHash("md5").update(String(token)).digest("hex").slice(0, 12)}`;
  return null;
};

export const listAccounts = async (): Promise<FourSellerAccount[]> => {
  const idx = await readIndex();
  return idx.accounts;
};

/** Sync danh sách shop của 1 tài khoản từ 4Seller. Trả về số shop, throw nếu cookie chết. */
export const refreshAccountShops = async (uid: string): Promise<string[]> => {
  const list = await getShopList(`acct:${uid}`);
  const records = list?.records ?? [];
  let shops = records
    .filter((s) => !s.platform || /tiktok/i.test(String(s.platform)))
    .map((s) => s.shopName)
    .filter(Boolean);
  if (shops.length === 0) shops = records.map((s) => s.shopName).filter(Boolean);
  shops.sort();

  const idx = await readIndex();
  const acc = idx.accounts.find((a) => a.uid === uid);
  if (acc) {
    acc.shops = shops;
    acc.shopsUpdatedAt = Date.now();
    await writeIndex(idx);
  }
  return shops;
};

/**
 * Lưu 1 file cookie export: tự detect tài khoản (uid) → ghi file + update registry
 * → sync shop list. Trả về account (kể cả khi sync shop lỗi — cookie vẫn được lưu).
 */
export const saveAccountCookie = async (
  parsed: any,
  opts?: { targetUid?: string }
): Promise<{ account: FourSellerAccount; shopSyncError?: string; matchedBy?: { label: string; hit: number; total: number } }> => {
  const cookies = normalizeCookieArray(parsed);
  if (cookies.length === 0) throw new Error("File cookie rỗng hoặc sai format (cần array cookie export)");
  const hasFourSeller = cookies.some((c) => String(c?.domain || "").includes("4seller.com"));
  if (!hasFourSeller) throw new Error("Không thấy cookie domain 4seller.com trong file");

  // targetUid: nút "Thay cookie" cho 1 tài khoản CỤ THỂ → ép cookie mới vào đúng tài khoản đó,
  // KỂ CẢ khi cookie mới thiếu `uid` hoặc userToken đổi (session mới) → tránh tạo tài khoản trùng.
  const detected = extractAccountUid(cookies);
  const existing = (await readIndex()).accounts;
  // Kéo file vào ô chung mà `uid` không khớp tài khoản nào (export thiếu cookie `uid` → hash
  // userToken đổi mỗi lần login; hoặc login bằng tài khoản con uid khác) → trước đây sinh tài
  // khoản TRÙNG y hệt shop. Giờ hỏi 4Seller danh sách shop của cookie mới rồi so shop.
  let matchedBy: { label: string; hit: number; total: number } | undefined;
  let uid = opts?.targetUid || (detected && existing.some((a) => a.uid === detected) ? detected : null);
  if (!uid) {
    const m = await matchAccountByShops(cookies, existing);
    if (m) { uid = m.uid; matchedBy = { label: m.label, hit: m.hit, total: m.total }; }
    else uid = detected;
  }
  if (!uid) throw new Error("Không detect được tài khoản (thiếu cookie `uid`/`userToken`). Bấm '🔄 Làm mới cookie' trên đúng tài khoản để gán thẳng.");

  // Đảm bảo file có cookie `uid` (API cần). Nút "Làm mới cookie" (targetUid) → ép đúng uid tài
  // khoản. Gộp theo shop → KHÔNG sửa uid có sẵn (tài khoản con có uid riêng, sửa là hỏng cookie).
  const dom = cookies.find((c) => String(c?.domain || "").includes("4seller.com"))?.domain || ".4seller.com";
  const uidCookie = cookies.find((c) => c?.name === "uid");
  if (uidCookie) { if (opts?.targetUid) uidCookie.value = String(uid); }
  else cookies.push({ name: "uid", value: String(uid), domain: dom, path: "/" });

  await fs.ensureDir(ACCOUNTS_DIR);
  await fs.writeFile(accountCookiePath(uid), JSON.stringify(cookies, null, 2), "utf-8");

  const idx = await readIndex();
  let acc = idx.accounts.find((a) => a.uid === uid);
  if (!acc) {
    acc = {
      uid,
      label: `Tài khoản ${idx.accounts.length + 1}`,
      shops: [],
      cookieCount: cookies.length,
      cookieUpdatedAt: Date.now(),
      shopsUpdatedAt: 0,
    };
    idx.accounts.push(acc);
  } else {
    acc.cookieCount = cookies.length;
    acc.cookieUpdatedAt = Date.now();
  }
  await writeIndex(idx);

  // Sync shop list bằng cookie mới (best-effort: cookie vừa paste có thể vẫn lỗi)
  let shopSyncError: string | undefined;
  try {
    acc.shops = await refreshAccountShops(uid);
    acc.shopsUpdatedAt = Date.now();
  } catch (e: any) {
    shopSyncError = e?.message ?? String(e);
  }
  return { account: acc, shopSyncError, matchedBy };
};

/** Lọc shop TikTok từ get-tidy-list (giống refreshAccountShops). */
const tiktokShops = (records: { platform?: string; shopName: string }[]): string[] => {
  const t = records.filter((s) => !s.platform || /tiktok/i.test(String(s.platform))).map((s) => s.shopName).filter(Boolean);
  return t.length ? t : records.map((s) => s.shopName).filter(Boolean);
};

/**
 * Cookie mới (chưa ghi ổ) thuộc tài khoản có sẵn nào? Lấy shop list bằng cookie trong RAM, tài
 * khoản nào chung ≥ 50% shop của cookie mới → là nó. Cookie chết → throw (không sinh tài khoản rác).
 * Lỗi mạng → null (rơi về cách nhận diện cũ theo uid).
 */
async function matchAccountByShops(
  cookies: any[],
  accounts: FourSellerAccount[]
): Promise<{ uid: string; label: string; hit: number; total: number } | null> {
  if (!accounts.length) return null;
  const { setExtCookie, clearExtCookie } = await import("../services/fourseller/client");
  const { isCookieDeadError } = await import("./cookieHealth");
  const key = `probe-${crypto.randomBytes(6).toString("hex")}`;
  let shops: string[];
  try {
    setExtCookie(key, JSON.stringify(cookies));
    shops = tiktokShops((await getShopList(`ext:${key}`))?.records ?? []);
  } catch (e: any) {
    if (isCookieDeadError(e)) throw new Error("Cookie này đã HẾT HẠN (4Seller từ chối) — không lưu. Export lại cookie sau khi đăng nhập 4Seller.");
    console.warn(`⚠️ Không lấy được shop của cookie mới để so tài khoản: ${e?.message ?? e}`);
    return null;
  } finally {
    clearExtCookie(key);
  }
  if (!shops.length) return null;
  const mine = new Set(shops.map(normShopName));
  let best: { uid: string; label: string; hit: number; total: number } | null = null;
  for (const a of accounts) {
    const hit = a.shops.filter((s) => mine.has(normShopName(s))).length;
    if (hit * 2 >= mine.size && hit > (best?.hit ?? 0)) best = { uid: a.uid, label: a.email || a.label, hit, total: mine.size };
  }
  return best;
}

export const setAccountLabel = async (uid: string, label: string): Promise<void> => {
  const idx = await readIndex();
  const acc = idx.accounts.find((a) => a.uid === uid);
  if (!acc) throw new Error(`Không có tài khoản uid=${uid}`);
  acc.label = label.trim() || acc.label;
  await writeIndex(idx);
};

/** Gán email cho tài khoản (auto-login biết email). Nếu label vẫn mặc định "Tài khoản N" → đổi luôn thành email cho dễ nhìn. */
export const setAccountEmail = async (uid: string, email: string): Promise<void> => {
  const e = (email || "").trim();
  if (!e) return;
  const idx = await readIndex();
  const acc = idx.accounts.find((a) => a.uid === uid);
  if (!acc) return;
  acc.email = e;
  if (/^Tài khoản \d+$/.test(acc.label || "")) acc.label = e;
  await writeIndex(idx);
};

export const deleteAccount = async (uid: string): Promise<void> => {
  const idx = await readIndex();
  idx.accounts = idx.accounts.filter((a) => a.uid !== uid);
  await writeIndex(idx);
  await fs.remove(accountCookiePath(uid)).catch(() => {});
};

/**
 * Tìm tài khoản sở hữu 1 shop (match theo tên chuẩn hoá — folder shop đặt theo
 * shopName thật nên thường khớp exact).
 * Không match: nếu chỉ có đúng 1 tài khoản → dùng luôn (đỡ bắt sync đủ shop list).
 */
export const resolveAccountForShop = async (
  shopFolder: string
): Promise<FourSellerAccount | null> => {
  const accounts = await listAccounts();
  if (accounts.length === 0) return null;
  const target = normShopName(shopFolder);
  for (const acc of accounts) {
    if (acc.shops.some((s) => normShopName(s) === target)) return acc;
  }
  if (accounts.length === 1) return accounts[0];
  return null;
};

/**
 * Path file cookie cho 1 shop — dùng bởi worker. Throw message rõ ràng khi chưa
 * upload cookie / shop không thuộc tài khoản nào.
 */
export const cookieFileForShop = async (shopFolder: string): Promise<string> => {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "Chưa có tài khoản 4Seller nào — mở Admin → tab Cookie 4Seller, kéo file cookie export vào."
    );
  }
  const acc = await resolveAccountForShop(shopFolder);
  if (!acc) {
    throw new Error(
      `Shop "${shopFolder}" không thuộc tài khoản 4Seller nào đã upload ` +
        `(${accounts.map((a) => `${a.label}: ${a.shops.length} shop`).join(", ")}). ` +
        `Bấm "Sync shop" ở tab Cookie hoặc kiểm tra shop đã import vào 4Seller chưa.`
    );
  }
  const file = accountCookiePath(acc.uid);
  if (!(await fs.pathExists(file))) {
    throw new Error(`File cookie của ${acc.label} (uid=${acc.uid}) không còn — paste lại ở tab Cookie.`);
  }
  return file;
};

/**
 * Bootstrap 1 lần: import cookie legacy data/cookies/<user>.json (cơ chế cũ theo
 * login user) vào registry tài khoản — chạy khi server start để chuyển đổi mượt.
 * File không có uid/userToken (export quá cũ) thì bỏ qua.
 */
export const bootstrapLegacyCookies = async (): Promise<void> => {
  try {
    const legacyDir = path.resolve(process.cwd(), "data", "cookies");
    if (!(await fs.pathExists(legacyDir))) return;
    const idx = await readIndex();
    // Migration 1 LẦN: đã có tài khoản trong registry → không import lại
    // (tránh file legacy rác/cũ bị re-import sau khi user đã xoá trên UI).
    if (idx.accounts.length > 0) return;
    const entries = (await fs.readdir(legacyDir)).filter(
      (f) => f.toLowerCase().endsWith(".json") && !f.includes(".bak")
    );
    for (const f of entries) {
      try {
        const parsed = await fs.readJson(path.join(legacyDir, f));
        const cookies = normalizeCookieArray(parsed);
        const uid = extractAccountUid(cookies);
        if (!uid) continue;
        const existing = idx.accounts.find((a) => a.uid === uid);
        // Chỉ import khi tài khoản CHƯA có (không ghi đè cookie mới hơn)
        if (existing) continue;
        console.log(`🍪 [bootstrap] Import cookie legacy ${f} → tài khoản uid=${uid}`);
        await saveAccountCookie(cookies);
      } catch {
        /* file lỗi → bỏ qua */
      }
    }
  } catch (e: any) {
    console.warn("⚠️ bootstrapLegacyCookies lỗi (bỏ qua):", e?.message);
  }
};
