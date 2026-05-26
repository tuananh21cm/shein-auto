import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";

type UserRole = "admin" | "editor" | "viewer";

export interface AdminUser {
  username: string;
  /** bcrypt hash. Format: $2a$... */
  password: string;
  role: UserRole;
  /** List shop folders user này có quyền xem (lọc UI). Rỗng = tất cả trong baseDir của họ. */
  profiles: string[];
  /** Thư mục SHEIN scraper tải JSON về cho user này. Empty = fallback DOWNLOAD_DIR env. */
  downloadDir?: string;
  /** Thư mục trung tâm chứa các shop folder của user này. Empty = fallback BASE_SHEINAUTO_DIR env. */
  baseSheinAutoDir?: string;
}

export interface AdminConfig {
  users: AdminUser[];
  settings: {
    adminPort: number;
  };
}

const adminConfigDir = path.resolve(process.cwd(), "data");
const adminConfigFile = path.join(adminConfigDir, "admin-config.json");

const BCRYPT_ROUNDS = 10;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

const hash = (plain: string): string => bcrypt.hashSync(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, stored: string): boolean => {
  if (!stored) return false;
  if (BCRYPT_RE.test(stored)) return bcrypt.compareSync(plain, stored);
  // Migration path: file cũ có plaintext → so sánh trực tiếp 1 lần, sẽ re-hash sau khi login.
  return plain === stored;
};
export const isHashed = (stored: string): boolean => BCRYPT_RE.test(stored);
export const hashPassword = (plain: string): string => hash(plain);

const DEFAULT_ADMIN_USER: AdminUser = {
  username: "admin",
  password: hash("admin"),
  role: "admin",
  profiles: [],
  downloadDir: "",
  baseSheinAutoDir: "",
};

const DEFAULT_CONFIG: AdminConfig = {
  users: [DEFAULT_ADMIN_USER],
  settings: {
    adminPort: Number(process.env.ADMIN_PORT ?? 3000),
  },
};

const normalizeConfig = (raw: any): AdminConfig => {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;

  const users: AdminUser[] =
    Array.isArray(raw.users) && raw.users.length > 0
      ? raw.users.map((user: any) => ({
          username: typeof user.username === "string" ? user.username : "",
          password: typeof user.password === "string" ? user.password : "",
          role: ["admin", "editor", "viewer"].includes(user.role) ? user.role : "viewer",
          profiles: Array.isArray(user.profiles)
            ? user.profiles.filter((p: any) => typeof p === "string")
            : [],
          downloadDir: typeof user.downloadDir === "string" ? user.downloadDir : "",
          baseSheinAutoDir:
            typeof user.baseSheinAutoDir === "string" ? user.baseSheinAutoDir : "",
        }))
      : [DEFAULT_ADMIN_USER];

  return {
    users,
    settings: {
      adminPort:
        raw.settings && typeof raw.settings.adminPort === "number"
          ? raw.settings.adminPort
          : DEFAULT_CONFIG.settings.adminPort,
    },
  };
};

export const ensureAdminConfig = async (): Promise<void> => {
  try {
    await fs.mkdir(adminConfigDir, { recursive: true });
    const stat = await fs.stat(adminConfigFile).catch(() => null);
    if (!stat) {
      await fs.writeFile(adminConfigFile, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    }
  } catch (error) {
    console.error("⚠️ Không thể tạo file admin-config.json:", error);
  }
};

export const loadAdminConfig = async (): Promise<AdminConfig> => {
  await ensureAdminConfig();
  try {
    const raw = await fs.readFile(adminConfigFile, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    console.error("⚠️ Không thể đọc admin-config.json:", error);
    return DEFAULT_CONFIG;
  }
};

export const saveAdminConfig = async (config: AdminConfig): Promise<AdminConfig> => {
  await ensureAdminConfig();
  const normalized = normalizeConfig(config);
  // Auto-hash bất kỳ password nào còn plaintext trước khi ghi đĩa
  normalized.users = normalized.users.map((u) =>
    u.password && !isHashed(u.password) ? { ...u, password: hash(u.password) } : u
  );
  await fs.writeFile(adminConfigFile, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
};
