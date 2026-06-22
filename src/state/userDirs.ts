import path from "path";
import fs from "fs-extra";
import { config } from "../config";
import { loadAdminConfig, AdminUser } from "../adminConfig";

export interface UserDirs {
  username: string;
  downloadDir: string;
  baseSheinAutoDir: string;
  /** Nếu user có profiles (list shop folder), chỉ scan/route các folder trong list này. */
  profiles: string[];
}

const normalize = (p: string): string => path.normalize(p.trim());

/**
 * Resolve dirs cho 1 user. Empty fields fallback về env defaults trong config.
 */
export const resolveUserDirs = (user: AdminUser): UserDirs => ({
  username: user.username,
  downloadDir: normalize(user.downloadDir || config.downloadDir),
  baseSheinAutoDir: normalize(user.baseSheinAutoDir || config.baseSheinAutoDir),
  profiles: user.profiles ?? [],
});

/**
 * Per-user iterator KHÔNG dedup. Mỗi user 1 entry, dùng cho worker/router
 * để giữ đúng preference (autoCron, headless) per-user.
 *
 * Chỉ include user có baseSheinAutoDir (sau khi resolve env fallback).
 */
export const getAllUsersForCron = async (): Promise<UserDirs[]> => {
  const cfg = await loadAdminConfig();
  return cfg.users
    .map(resolveUserDirs)
    .filter((d) => !!d.baseSheinAutoDir);
};

/**
 * Lấy danh sách tất cả user dirs (dedup theo baseSheinAutoDir).
 * Nếu 2 user có cùng baseDir, merge profiles (union).
 *
 * CHÚ Ý: dùng cho UI listings (show 1 card per shop). Worker phải dùng
 * `getAllUsersForCron` để giữ preference per-user chính xác.
 */
export const getAllUserDirs = async (): Promise<UserDirs[]> => {
  const cfg = await loadAdminConfig();
  const map = new Map<string, UserDirs>();

  for (const u of cfg.users) {
    const dirs = resolveUserDirs(u);
    if (!dirs.baseSheinAutoDir) continue;
    const existing = map.get(dirs.baseSheinAutoDir);
    if (existing) {
      // Merge profiles. profiles=[] = CATCH-ALL (xem TẤT CẢ shop trong baseDir).
      // Nếu MỘT user dùng chung baseDir là catch-all → kết quả phải catch-all,
      // KHÔNG được narrow xuống list của user explicit (union sai ở đây).
      if (existing.profiles.length === 0 || dirs.profiles.length === 0) {
        existing.profiles = [];
      } else {
        existing.profiles = Array.from(new Set([...existing.profiles, ...dirs.profiles]));
      }
      existing.username += `,${dirs.username}`;
    } else {
      map.set(dirs.baseSheinAutoDir, { ...dirs });
    }
  }
  return Array.from(map.values());
};

/**
 * Lấy dirs của 1 user cụ thể (theo username).
 */
export const getUserDirsByName = async (username: string): Promise<UserDirs | null> => {
  const cfg = await loadAdminConfig();
  const u = cfg.users.find((x) => x.username === username);
  if (!u) return null;
  return resolveUserDirs(u);
};

/**
 * Resolve brand name cho 1 (user, profile). CHỈ theo brand của user (đã bỏ global):
 *   1. user.brandProfilesOverride.profiles[profile] nếu có
 *   2. user.brandProfilesOverride.default nếu có
 *   3. "" (không brand)
 */
export const resolveBrandForUser = async (
  username: string | undefined | null,
  profileName: string
): Promise<string> => {
  const cfg = await loadAdminConfig();
  // Chuẩn hoá để so khớp profile: bỏ space + MỌI loại gạch (hyphen "-", en "–", em "—") + lowercase.
  // → "TA Scan 227 — Energetic Flags_US" (key brand) khớp "TA Scan 227-Energetic Flags_US" (folder thật).
  const norm = (s: string): string => (s || "").toLowerCase().replace(/[\s—–-]+/g, "");
  const np = norm(profileName);

  const matchInUser = (u: any): string => {
    const ov = u?.brandProfilesOverride;
    if (!ov?.profiles) return "";
    if (ov.profiles[profileName]) return ov.profiles[profileName]; // exact
    for (const [k, v] of Object.entries(ov.profiles)) {
      if (v && norm(k) === np) return v as string; // chuẩn hoá dấu/space
    }
    return "";
  };

  // 1. User chỉ định (cookie owner) — ưu tiên brand của chính họ cho shop này.
  if (username) {
    const u = cfg.users.find((x) => x.username === username);
    const b = matchInUser(u);
    if (b) return b;
  }
  // 2. Brand GẮN VỚI SHOP, không phụ thuộc cookie user → tìm shop ở MỌI user (vd map set ở 'admin').
  for (const u of cfg.users) {
    const b = matchInUser(u);
    if (b) return b;
  }
  // 3. Default brand của user chỉ định (nếu có).
  if (username) {
    const u = cfg.users.find((x) => x.username === username);
    if (u?.brandProfilesOverride?.default) return u.brandProfilesOverride.default;
  }
  return "";
};

/**
 * Tìm chủ sở hữu thật của 1 shop folder:
 *   - Ưu tiên 1: user có shop trong `profiles` explicit
 *   - Ưu tiên 2: user catch-all (profiles=[]) đầu tiên (sort alphabetical)
 *   - Trả null nếu không có user nào
 *
 * Dùng cho manual paths (run-now, retry) để lấy đúng cookie/preferences
 * của shop owner thay vì user đầu trong dedup merge.
 */
export const getShopOwner = async (shop: string): Promise<string | null> => {
  const cfg = await loadAdminConfig();
  // Chuẩn hoá để khớp: bỏ space + MỌI loại gạch (hyphen "-", en "–", em "—") + lowercase.
  // → profile "TA Scan 227 — Energetic Flags_US" khớp folder "TA Scan 227-Energetic Flags_US".
  // (Trước đây so khớp CHÍNH XÁC → em-dash ≠ hyphen → rơi về catch-all → dùng nhầm cookie user khác.)
  const norm = (s: string): string => (s || "").toLowerCase().replace(/[\s—–-]+/g, "");
  const ns = norm(shop);
  for (const u of cfg.users) {
    if ((u.profiles ?? []).some((p) => norm(p) === ns)) return u.username;
  }
  const catchAlls = cfg.users
    .filter((u) => (u.profiles ?? []).length === 0)
    .sort((a, b) => a.username.localeCompare(b.username));
  return catchAlls[0]?.username ?? null;
};

/**
 * Effective settings cho worker — GỘP VỀ GLOBAL (đã bỏ per-user override).
 *  - autoCron, headless (từ worker.json)
 *  - pricing (shipFee, multiplier, extraAdd — từ pricing.json)
 */
export const getEffectiveSettings = async (): Promise<{
  autoCron: boolean;
  headless: boolean;
  pricing: { shipFee: number; multiplier: number; extraAdd: number };
}> => {
  const { workerConfig, pricing: pricingGlobal } = await import("../config/appConfig");
  const w = workerConfig();
  const p = pricingGlobal();
  return {
    autoCron: w.autoCron,
    headless: w.headless,
    pricing: {
      shipFee:    p.shipFee    ?? 0,
      multiplier: p.multiplier ?? 1,
      extraAdd:   p.extraAdd   ?? 0,
    },
  };
};

export interface PathValidation {
  ok: boolean;
  exists: boolean;
  writable: boolean;
  isDirectory: boolean;
  error?: string;
  resolved?: string;
}

/**
 * Kiểm tra path có hợp lệ + tồn tại + writable không. Dùng cho UI test button.
 */
export const validatePath = async (rawPath: string): Promise<PathValidation> => {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, exists: false, writable: false, isDirectory: false, error: "Path rỗng" };
  }
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      exists: false,
      writable: false,
      isDirectory: false,
      error: "Phải là absolute path (vd: C:/Users/UserA/Downloads)",
    };
  }

  const resolved = path.normalize(trimmed);
  let exists = false;
  let isDirectory = false;
  let writable = false;

  try {
    const stat = await fs.stat(resolved);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      ok: false,
      exists: false,
      writable: false,
      isDirectory: false,
      error: "Folder không tồn tại",
      resolved,
    };
  }

  if (!isDirectory) {
    return {
      ok: false,
      exists: true,
      writable: false,
      isDirectory: false,
      error: "Path tồn tại nhưng không phải directory",
      resolved,
    };
  }

  try {
    await fs.access(resolved, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  return {
    ok: writable,
    exists: true,
    isDirectory: true,
    writable,
    error: writable ? undefined : "Folder không có quyền ghi",
    resolved,
  };
};

const norm = (p: string): string => path.normalize(p.trim()).replace(/[/\\]+$/, "");

const isSubdir = (parent: string, child: string): boolean => {
  if (parent === child) return false;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Detect conflicts giữa downloadDir/baseSheinAutoDir của tất cả user.
 * Rules:
 *  - Cùng 1 user: downloadDir != baseSheinAutoDir
 *  - 2 user khác: 2 downloadDir không trùng (router sẽ tranh chấp file)
 *  - 2 user khác: 2 baseSheinAutoDir không trùng (worker tranh shop folder)
 *  - downloadDir của user A không được nằm trong baseSheinAutoDir của user B (router B sẽ ăn file của A)
 *  - baseSheinAutoDir của A không được là subdir của baseSheinAutoDir của B
 *
 * Cho phép: user có 1 trong 2 field rỗng (= fallback env default → coi như chia sẻ default).
 */
export const detectDirConflicts = (
  users: { username: string; downloadDir?: string; baseSheinAutoDir?: string }[]
): string | null => {
  type Entry = { username: string; field: "downloadDir" | "baseSheinAutoDir"; path: string };
  const entries: Entry[] = [];
  for (const u of users) {
    if (u.downloadDir && u.downloadDir.trim()) {
      entries.push({ username: u.username, field: "downloadDir", path: norm(u.downloadDir) });
    }
    if (u.baseSheinAutoDir && u.baseSheinAutoDir.trim()) {
      entries.push({ username: u.username, field: "baseSheinAutoDir", path: norm(u.baseSheinAutoDir) });
    }
  }

  // Same user: downloadDir != baseSheinAutoDir
  for (const u of users) {
    if (u.downloadDir && u.baseSheinAutoDir && norm(u.downloadDir) === norm(u.baseSheinAutoDir)) {
      return `User '${u.username}': downloadDir và baseSheinAutoDir không được trùng (${norm(u.downloadDir)})`;
    }
  }

  // Pairwise check
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.username === b.username) continue;

      if (a.path === b.path) {
        return `Conflict: ${a.username}.${a.field} và ${b.username}.${b.field} cùng path "${a.path}"`;
      }
      if (isSubdir(a.path, b.path)) {
        return `Conflict: ${b.username}.${b.field} ("${b.path}") nằm trong ${a.username}.${a.field} ("${a.path}")`;
      }
      if (isSubdir(b.path, a.path)) {
        return `Conflict: ${a.username}.${a.field} ("${a.path}") nằm trong ${b.username}.${b.field} ("${b.path}")`;
      }
    }
  }

  return null;
};
