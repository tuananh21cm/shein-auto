import path from "path";
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
 * Lấy danh sách tất cả user dirs (dedup theo baseSheinAutoDir).
 * Nếu 2 user có cùng baseDir, merge profiles (union).
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
