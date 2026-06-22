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
  // v5: Signal Store cho Win Intelligence Engine (research P1).
  //   research_product  — snapshot 1 sp đã chấm điểm theo ngày (dedup theo day+goodsId)
  //   research_niche    — rollup theo ngách theo ngày (heat, supply, avgWin)
  //   research_candidate— danh sách candidate chọn để đăng, status duyệt 1-click
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_product (
        day TEXT NOT NULL,                -- YYYY-MM-DD (UTC) snapshot
        goods_id TEXT NOT NULL,
        niche_key TEXT NOT NULL,
        niche_group TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        store_code TEXT,
        price REAL,
        retail_price REAL,
        discount_pct REAL,
        final_price REAL,                 -- giá bán dự kiến (công thức pricing.json)
        comment_num INTEGER NOT NULL DEFAULT 0,
        rating REAL,
        sold_num INTEGER,                 -- sold thật nếu đã làm giàu qua Kiki (NULL = chưa)
        win_score REAL NOT NULL DEFAULT 0,
        win_tier TEXT NOT NULL DEFAULT 'weak',
        margin_score REAL NOT NULL DEFAULT 0,
        opportunity_score REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (day, goods_id, niche_key)
      );
      CREATE INDEX IF NOT EXISTS idx_rp_day_opp ON research_product(day, opportunity_score DESC);
      CREATE INDEX IF NOT EXISTS idx_rp_niche ON research_product(niche_key, day);

      CREATE TABLE IF NOT EXISTS research_niche (
        day TEXT NOT NULL,
        niche_key TEXT NOT NULL,
        niche_group TEXT NOT NULL DEFAULT '',
        query TEXT NOT NULL DEFAULT '',
        supply_count INTEGER NOT NULL DEFAULT 0,
        avg_top_win REAL NOT NULL DEFAULT 0,
        hot_share REAL NOT NULL DEFAULT 0,    -- % sp tier hot/good
        median_price REAL,
        margin_band REAL NOT NULL DEFAULT 0,
        heat_score REAL NOT NULL DEFAULT 0,   -- 0-100 nhiệt ngách
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (day, niche_key)
      );
      CREATE INDEX IF NOT EXISTS idx_rn_day_heat ON research_niche(day, heat_score DESC);

      CREATE TABLE IF NOT EXISTS research_candidate (
        id TEXT PRIMARY KEY,              -- day:goodsId
        day TEXT NOT NULL,
        goods_id TEXT NOT NULL,
        niche_key TEXT NOT NULL,
        niche_group TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        store_code TEXT,
        price REAL,
        final_price REAL,
        comment_num INTEGER NOT NULL DEFAULT 0,
        rating REAL,
        sold_num INTEGER,
        win_score REAL NOT NULL DEFAULT 0,
        win_tier TEXT NOT NULL DEFAULT 'weak',
        opportunity_score REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',  -- lý do vì sao được chọn (rule-based; AI gắn ở P4)
        status TEXT NOT NULL DEFAULT 'new', -- new | approved | queued | dismissed
        target_shop TEXT,                -- shop đích khi approve (vd P5-022)
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rc_day_status ON research_candidate(day, status);
      CREATE INDEX IF NOT EXISTS idx_rc_status_opp ON research_candidate(status, opportunity_score DESC);
    `);
  },
  // v6: Kiki enrichment (P2) — sold thật + rank Bestseller.
  //   sold_text  : chuỗi gốc SHEIN ("6.6k+")
  //   rank_text  : banner rank ("No.1 Bestseller in <ngách>") — best-effort
  //   enriched_at: mốc đã làm giàu (NULL = chưa)
  (db) => {
    db.exec(`
      ALTER TABLE research_product ADD COLUMN sold_text TEXT;
      ALTER TABLE research_product ADD COLUMN rank_text TEXT;
      ALTER TABLE research_product ADD COLUMN enriched_at INTEGER;
      ALTER TABLE research_candidate ADD COLUMN sold_text TEXT;
      ALTER TABLE research_candidate ADD COLUMN rank_text TEXT;
      ALTER TABLE research_candidate ADD COLUMN enriched_at INTEGER;
    `);
  },
  // v7: AI reasoning (P4 — Gemini). ai_reason per candidate + briefing/ngách gợi ý theo ngày.
  (db) => {
    db.exec(`
      ALTER TABLE research_candidate ADD COLUMN ai_reason TEXT;

      CREATE TABLE IF NOT EXISTS research_briefing (
        day TEXT PRIMARY KEY,
        briefing TEXT NOT NULL DEFAULT '',
        suggestions TEXT NOT NULL DEFAULT '[]', -- JSON: [{key,query,why}]
        created_at INTEGER NOT NULL
      );
    `);
  },
  // v8: Deep Validation Gate — kết quả kiểm định sâu detail (Kiki).
  (db) => {
    db.exec(`
      ALTER TABLE research_candidate ADD COLUMN validation_score REAL;
      ALTER TABLE research_candidate ADD COLUMN verdict TEXT;          -- PASS | WATCH | REJECT
      ALTER TABLE research_candidate ADD COLUMN is_local INTEGER;       -- 1 local / 0 inter / NULL unknown
      ALTER TABLE research_candidate ADD COLUMN ship_mode TEXT;         -- local | international | unknown
      ALTER TABLE research_candidate ADD COLUMN ship_days INTEGER;      -- est business days min
      ALTER TABLE research_candidate ADD COLUMN true_to_size REAL;      -- % (NULL = không lấy được)
      ALTER TABLE research_candidate ADD COLUMN ugc_count INTEGER;
      ALTER TABLE research_candidate ADD COLUMN ip_risk INTEGER;        -- 1 = nghi ngờ bản quyền
      ALTER TABLE research_candidate ADD COLUMN validation_json TEXT;   -- breakdown đầy đủ
      ALTER TABLE research_candidate ADD COLUMN validated_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_rc_verdict ON research_candidate(day, verdict);
    `);
  },
  // v9: P3 Demand layer (Kalodata) — snapshot demand TikTok US theo ngày.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kalodata_category (
        day TEXT NOT NULL,
        cate_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT '',
        revenue REAL,                  -- đã parse ra số (VND)
        growth_rate REAL,              -- 0..1 (vd 0.04 = 4%)
        shop_number INTEGER,
        avg_revenue REAL,
        top3_ratio REAL,               -- độ tập trung top 3 shop
        top10_ratio REAL,
        trend_slope REAL,              -- độ dốc revenue_trend (nửa cuối / nửa đầu)
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (day, cate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kcat_day ON kalodata_category(day, revenue DESC);

      CREATE TABLE IF NOT EXISTS kalodata_product (
        day TEXT NOT NULL,
        product_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        revenue REAL,
        sale INTEGER,                  -- units bán
        unit_price REAL,
        commission_rate REAL,
        product_rating REAL,
        is_local INTEGER,              -- 1 = delivery_type local / is_overseas=0
        launch_date TEXT,
        creator_num INTEGER,
        pri_cate_id TEXT,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (day, product_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kprod_day ON kalodata_product(day, revenue DESC);
    `);
  },
  // v10: drill-down ngách — numeric id category + tag product theo category đã pull.
  (db) => {
    db.exec(`
      ALTER TABLE kalodata_category ADD COLUMN numeric_id TEXT;
      ALTER TABLE kalodata_product ADD COLUMN cate_filter TEXT;  -- category name product được pull theo (NULL = global top)
      CREATE INDEX IF NOT EXISTS idx_kprod_cate ON kalodata_product(day, cate_filter);
    `);
  },
  // v11: Niche Lab P2 — gán ngách cho từng shop (danh mục 10 shop).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shop_niche (
        shop TEXT NOT NULL,
        niche_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'testing',  -- testing | scaling | dropped
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop, niche_key)
      );
      CREATE INDEX IF NOT EXISTS idx_shopniche_shop ON shop_niche(shop);
    `);
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
