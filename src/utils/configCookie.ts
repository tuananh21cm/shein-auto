import fs from "fs/promises";
import { config } from "../config";

type RawCookie = Record<string, any>;

const normalizeSameSite = (v: any): "Strict" | "Lax" | "None" | undefined => {
  if (!v || v === "unspecified" || v === "no_restriction") return undefined;
  const s = String(v).toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
};

/**
 * Convert 1 cookie record (từ Cookie Editor extension hoặc Playwright export)
 * sang format Playwright `BrowserContext.addCookies` chấp nhận.
 */
const toPlaywright = (item: RawCookie) => {
  const out: any = {
    name: item.name,
    value: item.value,
    domain: item.domain,
    path: item.path ?? "/",
  };
  // Cookie Editor dùng `expirationDate` (epoch seconds, float). Playwright muốn `expires`.
  if (typeof item.expirationDate === "number") out.expires = Math.floor(item.expirationDate);
  else if (typeof item.expires === "number") out.expires = item.expires;

  if (typeof item.httpOnly === "boolean") out.httpOnly = item.httpOnly;
  if (typeof item.secure === "boolean") out.secure = item.secure;

  const ss = normalizeSameSite(item.sameSite);
  if (ss) out.sameSite = ss;

  return out;
};

export const configCookie = async (_input?: string) => {
  const raw = await fs.readFile(config.cookieFile, "utf-8");
  const parsed = JSON.parse(raw);

  // Hỗ trợ 2 format:
  // 1. Array trực tiếp: [{...}, {...}]
  // 2. Cookie Editor wrapper: {url, cookies: [...]}
  const cookies: RawCookie[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
    ? parsed.cookies
    : [];

  return cookies.map(toPlaywright);
};
