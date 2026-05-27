import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./state/db";

type UserRole = "admin" | "editor" | "viewer";

export interface AdminUser {
  username: string;
  /** bcrypt hash. Format: $2a$... */
  password: string;
  role: UserRole;
  profiles: string[];
  downloadDir?: string;
  baseSheinAutoDir?: string;
  apiToken?: string;
  /** Override autoCron: null = inherit global worker.json, true/false = override */
  autoCronOverride?: boolean | null;
  /** Override headless: null = inherit global worker.json, true/false = override */
  headlessOverride?: boolean | null;
  /** Override pricing: null = inherit global pricing.json */
  shipFeeOverride?: number | null;
  multiplierOverride?: number | null;
  extraAddOverride?: number | null;
  /** Override brand mapping cho user này. null = inherit global brand-profiles.json */
  brandProfilesOverride?: { default?: string; profiles?: Record<string, string> } | null;
}

export interface AdminConfig {
  users: AdminUser[];
  settings: {
    adminPort: number;
  };
}

const BCRYPT_ROUNDS = 10;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

const hash = (plain: string): string => bcrypt.hashSync(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, stored: string): boolean => {
  if (!stored) return false;
  if (BCRYPT_RE.test(stored)) return bcrypt.compareSync(plain, stored);
  return plain === stored; // legacy plaintext, sẽ re-hash sau login
};
export const isHashed = (stored: string): boolean => BCRYPT_RE.test(stored);
export const hashPassword = (plain: string): string => hash(plain);

export const generateApiToken = (): string =>
  "tm_" + crypto.randomBytes(32).toString("hex");

interface UserRow {
  username: string;
  password_hash: string;
  role: string;
  profiles: string;
  download_dir: string;
  base_shein_auto_dir: string;
  api_token: string;
  auto_cron_override: number | null;
  headless_override: number | null;
  ship_fee_override: number | null;
  multiplier_override: number | null;
  extra_add_override: number | null;
  brand_profiles_override: string | null;
  created_at: number;
  updated_at: number;
}

const intToBoolOrNull = (v: number | null): boolean | null => {
  if (v === null || v === undefined) return null;
  return v === 1;
};
const boolOrNullToInt = (v: boolean | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
};

const rowToUser = (row: UserRow): AdminUser => ({
  username: row.username,
  password: row.password_hash,
  role: (["admin", "editor", "viewer"].includes(row.role) ? row.role : "viewer") as UserRole,
  profiles: (() => {
    try { return JSON.parse(row.profiles || "[]"); } catch { return []; }
  })(),
  downloadDir: row.download_dir || "",
  baseSheinAutoDir: row.base_shein_auto_dir || "",
  apiToken: row.api_token || "",
  autoCronOverride: intToBoolOrNull(row.auto_cron_override),
  headlessOverride: intToBoolOrNull(row.headless_override),
  shipFeeOverride: row.ship_fee_override,
  multiplierOverride: row.multiplier_override,
  extraAddOverride: row.extra_add_override,
  brandProfilesOverride: (() => {
    if (!row.brand_profiles_override) return null;
    try { return JSON.parse(row.brand_profiles_override); } catch { return null; }
  })(),
});

const ensureDefaultAdmin = (): void => {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  if (count > 0) return;
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (
      username, password_hash, role, profiles, download_dir, base_shein_auto_dir, api_token,
      auto_cron_override, headless_override, ship_fee_override, multiplier_override, extra_add_override,
      brand_profiles_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin", hash("admin"), "admin", "[]", "", "", "", null, null, null, null, null, null, now, now);
  console.log("👤 Tạo user admin/admin mặc định (đổi password ngay sau khi đăng nhập)");
};

export const ensureAdminConfig = async (): Promise<void> => {
  ensureDefaultAdmin();
};

export const loadAdminConfig = async (): Promise<AdminConfig> => {
  ensureDefaultAdmin();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[];
  const users = rows.map(rowToUser);
  return {
    users,
    settings: { adminPort: Number(process.env.ADMIN_PORT ?? 3000) },
  };
};

/**
 * Save toàn bộ config. Replace policy: trong transaction, xoá users không có
 * trong payload + upsert users trong payload. Password rỗng giữ nguyên hash cũ.
 */
export const saveAdminConfig = async (config: AdminConfig): Promise<AdminConfig> => {
  const db = getDb();
  const now = Date.now();

  const existing = db.prepare("SELECT * FROM users").all() as UserRow[];
  const existingMap = new Map(existing.map((r) => [r.username, r]));
  const targetUsernames = new Set(config.users.map((u) => u.username));

  const upsert = db.prepare(`
    INSERT INTO users (
      username, password_hash, role, profiles, download_dir, base_shein_auto_dir, api_token,
      auto_cron_override, headless_override, ship_fee_override, multiplier_override, extra_add_override,
      brand_profiles_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role          = excluded.role,
      profiles      = excluded.profiles,
      download_dir  = excluded.download_dir,
      base_shein_auto_dir = excluded.base_shein_auto_dir,
      api_token     = excluded.api_token,
      auto_cron_override   = excluded.auto_cron_override,
      headless_override    = excluded.headless_override,
      ship_fee_override    = excluded.ship_fee_override,
      multiplier_override  = excluded.multiplier_override,
      extra_add_override   = excluded.extra_add_override,
      brand_profiles_override = excluded.brand_profiles_override,
      updated_at    = excluded.updated_at
  `);
  const del = db.prepare("DELETE FROM users WHERE username = ?");

  const tx = db.transaction(() => {
    // Delete users không còn trong payload
    for (const row of existing) {
      if (!targetUsernames.has(row.username)) del.run(row.username);
    }
    // Upsert users trong payload
    for (const u of config.users) {
      const existed = existingMap.get(u.username);
      // Password: nếu rỗng → giữ hash cũ. Nếu plaintext → hash. Nếu đã hash → giữ.
      let passwordHash: string;
      if (!u.password) {
        passwordHash = existed?.password_hash ?? "";
      } else if (isHashed(u.password)) {
        passwordHash = u.password;
      } else {
        passwordHash = hashPassword(u.password);
      }
      upsert.run(
        u.username,
        passwordHash,
        u.role,
        JSON.stringify(u.profiles ?? []),
        u.downloadDir ?? "",
        u.baseSheinAutoDir ?? "",
        u.apiToken ?? "",
        boolOrNullToInt(u.autoCronOverride ?? null),
        boolOrNullToInt(u.headlessOverride ?? null),
        typeof u.shipFeeOverride === "number" ? u.shipFeeOverride : null,
        typeof u.multiplierOverride === "number" ? u.multiplierOverride : null,
        typeof u.extraAddOverride === "number" ? u.extraAddOverride : null,
        u.brandProfilesOverride ? JSON.stringify(u.brandProfilesOverride) : null,
        existed?.created_at ?? now,
        now
      );
    }
  });
  tx();

  return loadAdminConfig();
};

export const findUserByToken = async (token: string): Promise<AdminUser | null> => {
  if (!token || !token.startsWith("tm_")) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE api_token = ?").get(token) as UserRow | undefined;
  return row ? rowToUser(row) : null;
};
