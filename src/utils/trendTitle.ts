/**
 * Trend keyword — chèn keyword theo mùa (vd "Back to School") vào title lúc list.
 * Config: config/trend.json (enabled + keyword + position + shops).
 * Shop match theo tên profile CHUẨN HOÁ (bỏ space + mọi loại gạch, lowercase) —
 * cùng quy tắc với brand match ở userDirs.resolveBrandForUser.
 */
import { trendConfig } from "../config/appConfig";

const norm = (s: string): string => (s || "").toLowerCase().replace(/[\s—–-]+/g, "");

/** Chèn keyword vào title (pure — dễ test). Title đã chứa keyword → giữ nguyên. */
export const addTrendKeyword = (
  title: string,
  keyword: string,
  position: "prefix" | "suffix"
): string => {
  const t = (title || "").trim();
  const k = (keyword || "").trim();
  if (!t || !k) return t;
  if (t.toLowerCase().includes(k.toLowerCase())) return t; // AI/brand đã có sẵn → không lặp
  return position === "suffix" ? `${t} ${k}` : `${k} ${t}`;
};

/** Shop này có bật trend không (theo config/trend.json)? */
export const trendAppliesTo = (profileName: string): boolean => {
  const cfg = trendConfig();
  if (!cfg.enabled || !cfg.keyword?.trim()) return false;
  const np = norm(profileName);
  return (cfg.shops ?? []).some((s) => norm(s) === np);
};

/** Áp trend keyword cho title nếu shop nằm trong danh sách config. */
export const applyTrendKeyword = (title: string, profileName: string): string => {
  if (!trendAppliesTo(profileName)) return title;
  const cfg = trendConfig();
  return addTrendKeyword(title, cfg.keyword, cfg.position === "suffix" ? "suffix" : "prefix");
};
