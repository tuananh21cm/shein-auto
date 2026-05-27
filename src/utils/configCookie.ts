import fs from "fs/promises";
import fsx from "fs-extra";
import path from "path";

type RawCookie = Record<string, any>;

const PER_USER_COOKIE_DIR = path.resolve(process.cwd(), "data", "cookies");

const normalizeSameSite = (v: any): "Strict" | "Lax" | "None" | undefined => {
  if (!v || v === "unspecified" || v === "no_restriction") return undefined;
  const s = String(v).toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
};

const toPlaywright = (item: RawCookie) => {
  const out: any = {
    name: item.name,
    value: item.value,
    domain: item.domain,
    path: item.path ?? "/",
  };
  if (typeof item.expirationDate === "number") out.expires = Math.floor(item.expirationDate);
  else if (typeof item.expires === "number") out.expires = item.expires;
  if (typeof item.httpOnly === "boolean") out.httpOnly = item.httpOnly;
  if (typeof item.secure === "boolean") out.secure = item.secure;
  const ss = normalizeSameSite(item.sameSite);
  if (ss) out.sameSite = ss;
  return out;
};

/** Trả về absolute path file cookie cho 1 user. */
export const userCookiePath = (username: string): string =>
  path.join(PER_USER_COOKIE_DIR, `${username}.json`);

/**
 * Tải cookie 4Seller cho 1 user. Mỗi user BẮT BUỘC phải upload cookie riêng
 * qua Admin UI → tab Cookie 4Seller. Không còn fallback global.
 *
 * @throws Error nếu username trống hoặc file chưa tồn tại.
 */
export const configCookie = async (username?: string | null): Promise<any[]> => {
  if (!username || typeof username !== "string") {
    throw new Error(
      "configCookie cần username — mỗi user có cookie 4Seller riêng. Worker phải truyền owner."
    );
  }

  const userFile = userCookiePath(username);
  if (!(await fsx.pathExists(userFile))) {
    throw new Error(
      `User "${username}" chưa upload cookie 4Seller. Mở http://localhost:3000/admin → tab Cookie 4Seller → paste JSON → Lưu.`
    );
  }

  const raw = await fs.readFile(userFile, "utf-8");
  const parsed = JSON.parse(raw);
  const cookies: RawCookie[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
    ? parsed.cookies
    : [];

  if (cookies.length === 0) {
    throw new Error(
      `Cookie của "${username}" rỗng. Mở tab Cookie 4Seller để paste lại.`
    );
  }

  console.log(`🍪 Loaded ${cookies.length} cookies (user:${username})`);
  return cookies.map(toPlaywright);
};
