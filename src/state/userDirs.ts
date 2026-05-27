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
      // Merge profiles
      const merged = Array.from(new Set([...existing.profiles, ...dirs.profiles]));
      existing.profiles = merged;
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
 * Resolve brand name cho 1 (user, profile). Logic:
 *   1. user.brandProfilesOverride.profiles[profile] nếu có
 *   2. user.brandProfilesOverride.default nếu có
 *   3. global brand-profiles.json profiles[profile]
 *   4. global brand-profiles.json default
 */
export const resolveBrandForUser = async (
  username: string | undefined | null,
  profileName: string
): Promise<string> => {
  const { resolveBrand } = await import("../config/appConfig");
  if (!username) return resolveBrand(profileName);
  const cfg = await loadAdminConfig();
  const u = cfg.users.find((x) => x.username === username);
  const override = u?.brandProfilesOverride;
  if (override) {
    if (override.profiles && override.profiles[profileName]) return override.profiles[profileName];
    if (override.default) return override.default;
  }
  return resolveBrand(profileName);
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
  for (const u of cfg.users) {
    if ((u.profiles ?? []).includes(shop)) return u.username;
  }
  const catchAlls = cfg.users
    .filter((u) => (u.profiles ?? []).length === 0)
    .sort((a, b) => a.username.localeCompare(b.username));
  return catchAlls[0]?.username ?? null;
};

/**
 * Resolve effective settings cho 1 user: override của user → global default.
 *
 * Bao gồm:
 *  - autoCron, headless (từ worker.json)
 *  - pricing (shipFee, multiplier, extraAdd — từ pricing.json)
 */
export const getEffectiveSettings = async (username: string): Promise<{
  autoCron: boolean;
  headless: boolean;
  pricing: { shipFee: number; multiplier: number; extraAdd: number };
}> => {
  const { workerConfig, pricing: pricingGlobal } = await import("../config/appConfig");
  const w = workerConfig();
  const p = pricingGlobal();
  const cfg = await loadAdminConfig();
  const u = cfg.users.find((x) => x.username === username);
  return {
    autoCron: u?.autoCronOverride ?? w.autoCron,
    headless: u?.headlessOverride ?? w.headless,
    pricing: {
      shipFee:    u?.shipFeeOverride    ?? p.shipFee    ?? 0,
      multiplier: u?.multiplierOverride ?? p.multiplier ?? 1,
      extraAdd:   u?.extraAddOverride   ?? p.extraAdd   ?? 0,
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
