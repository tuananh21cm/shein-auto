import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "shein-auto.db");

let _db: Database.Database | null = null;

/**
 * Migrations chạy tuần tự. Mỗi migration là 1 hàm áp dụng cho db.
 * PRAGMA user_version dùng để track migration đã chạy.
 */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // v1: schema ban đầu
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        profiles TEXT NOT NULL DEFAULT '[]',
        download_dir TEXT NOT NULL DEFAULT '',
        base_shein_auto_dir TEXT NOT NULL DEFAULT '',
        api_token TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_api_token ON users(api_token);

      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        folder TEXT NOT NULL,
        profile TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_finished ON history(finished_at DESC);
      CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);
      CREATE INDEX IF NOT EXISTS idx_history_folder ON history(folder);

      CREATE TABLE IF NOT EXISTS gemini_cache (
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        output TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, cache_key)
      );

      CREATE TABLE IF NOT EXISTS settings_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // v2: per-user override cho autoCron + headless (3-state, NULL = inherit global)
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN auto_cron_override INTEGER;
      ALTER TABLE users ADD COLUMN headless_override INTEGER;
    `);
  },
  // v3: per-user pricing override. NULL = inherit global pricing.json
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN ship_fee_override REAL;
      ALTER TABLE users ADD COLUMN multiplier_override REAL;
      ALTER TABLE users ADD COLUMN extra_add_override REAL;
    `);
  },
  // v4: per-user brand mapping override (JSON: {default?: string, profiles?: {[p]: brand}})
  (db) => {
    db.exec(`ALTER TABLE users ADD COLUMN brand_profiles_override TEXT;`);
  },
];

const runMigrations = (db: Database.Database): void => {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    console.log(`🗄️  Running migration v${i + 1}...`);
    db.transaction(() => {
      MIGRATIONS[i](db);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
};

/**
 * Import dữ liệu từ JSON files cũ (nếu có) sang SQLite.
 * Chỉ chạy 1 lần khi table tương ứng đang rỗng.
 * Sau khi import xong, đổi tên file JSON cũ thành .migrated để khỏi import lại.
 */
const importLegacyJson = async (db: Database.Database): Promise<void> => {
  // ── users ──
  const usersCount = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (usersCount.c === 0) {
    const legacy = path.join(DATA_DIR, "admin-config.json");
    if (await fs.pathExists(legacy)) {
      try {
        const raw = await fs.readFile(legacy, "utf-8");
        const cfg = JSON.parse(raw);
        const now = Date.now();
        const insert = db.prepare(`
          INSERT INTO users (username, password_hash, role, profiles, download_dir, base_shein_auto_dir, api_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = db.transaction((users: any[]) => {
          for (const u of users) {
            insert.run(
              u.username,
              u.password ?? "",
              u.role ?? "viewer",
              JSON.stringify(u.profiles ?? []),
              u.downloadDir ?? "",
              u.baseSheinAutoDir ?? "",
              u.apiToken ?? "",
              now,
              now
            );
          }
        });
        tx(cfg.users ?? []);
        await fs.move(legacy, legacy + ".migrated", { overwrite: true }).catch(() => {});
        console.log(`📥 Imported ${cfg.users?.length ?? 0} users → DB`);
      } catch (err) {
        console.warn("⚠️ Không import được admin-config.json:", err);
      }
    }
  }

  // ── history ──
  const histCount = db.prepare("SELECT COUNT(*) as c FROM history").get() as { c: number };
  if (histCount.c === 0) {
    const legacy = path.join(DATA_DIR, "history.json");
    if (await fs.pathExists(legacy)) {
      try {
        const raw = await fs.readFile(legacy, "utf-8");
        const arr = JSON.parse(raw) as any[];
        const insert = db.prepare(`
          INSERT INTO history (id, file, folder, profile, status, started_at, finished_at, duration_ms, error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = db.transaction((rows: any[]) => {
          for (const r of rows) {
            insert.run(
              r.id,
              r.file,
              r.folder,
              r.profile,
              r.status,
              r.startedAt,
              r.finishedAt,
              r.durationMs,
              r.errorMessage ?? null
            );
          }
        });
        tx(arr);
        await fs.move(legacy, legacy + ".migrated", { overwrite: true }).catch(() => {});
        console.log(`📥 Imported ${arr.length} history entries → DB`);
      } catch (err) {
        console.warn("⚠️ Không import được history.json:", err);
      }
    }
  }

  // ── gemini cache ──
  const cacheCount = db.prepare("SELECT COUNT(*) as c FROM gemini_cache").get() as { c: number };
  if (cacheCount.c === 0) {
    const legacy = path.join(DATA_DIR, "cache", "gemini.json");
    if (await fs.pathExists(legacy)) {
      try {
        const raw = await fs.readFile(legacy, "utf-8");
        const parsed = JSON.parse(raw);
        const insert = db.prepare(`
          INSERT OR REPLACE INTO gemini_cache (kind, cache_key, output, created_at)
          VALUES (?, ?, ?, ?)
        `);
        const now = Date.now();
        const tx = db.transaction(() => {
          for (const [k, v] of Object.entries(parsed.titles ?? {})) {
            insert.run("title", k, v as string, now);
          }
          for (const [k, v] of Object.entries(parsed.categories ?? {})) {
            insert.run("category", k, v as string, now);
          }
        });
        tx();
        const tCount = Object.keys(parsed.titles ?? {}).length;
        const cCount = Object.keys(parsed.categories ?? {}).length;
        await fs.move(legacy, legacy + ".migrated", { overwrite: true }).catch(() => {});
        console.log(`📥 Imported ${tCount} title + ${cCount} category cache → DB`);
      } catch (err) {
        console.warn("⚠️ Không import được gemini.json:", err);
      }
    }
  }
};

export const getDb = (): Database.Database => {
  if (_db) return _db;
  fs.ensureDirSync(DATA_DIR);
  _db = new Database(DB_FILE);
  _db.pragma("journal_mode = WAL"); // tốt cho concurrent reads
  _db.pragma("foreign_keys = ON");
  runMigrations(_db);
  return _db;
};

export const initDb = async (): Promise<void> => {
  const db = getDb();
  await importLegacyJson(db);
  console.log(`🗄️  DB ready: ${DB_FILE}`);
};

export const closeDb = (): void => {
  if (_db) {
    _db.close();
    _db = null;
  }
};
