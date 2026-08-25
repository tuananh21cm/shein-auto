/**
 * Phase 1 — Kho snapshot THEO NGÀY cho từng shop (time-series).
 *
 * Song song với store "latest" hiện có (không phá UI cũ). Mỗi lần data về:
 *   1. Archive JSON: data/tikcrm/daily/<code>/<YYYY-MM-DD>/<kind>.json  (last-write-in-day thắng)
 *   2. Upsert 1 dòng chỉ số vào SQLite index (data/tikcrm/tikcrm.db, tách khỏi shein-auto.db)
 *      → dashboard/report truy vấn nhanh + tính Δ mà không phải quét folder.
 *
 * Ngày theo giờ VN (Asia/Ho_Chi_Minh) để khớp vận hành.
 */
import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(process.cwd(), "data", "tikcrm", "daily");
const DB_FILE = path.resolve(process.cwd(), "data", "tikcrm", "tikcrm.db");
const safeCode = (s: any) => String(s || "unknown").replace(/[^\w.-]/g, "_").slice(0, 120);
const safeKind = (s: any) => String(s || "x").replace(/[^\w-]/g, "").slice(0, 40);

/** YYYY-MM-DD theo giờ VN. */
export function dayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(d);
}

const num = (v: any): number | null => {
  if (v == null) return null;
  if (typeof v === "object") v = v.amount ?? v.format_without_symbol ?? null;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  fs.ensureDirSync(path.dirname(DB_FILE));
  const d = new Database(DB_FILE);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS shop_daily (
      shop_code TEXT NOT NULL,
      day TEXT NOT NULL,
      shop_name TEXT, region TEXT, shop_status TEXT,
      assessment_level INTEGER, violation_score INTEGER,
      net_earnings REAL, on_hold REAL, total_holding REAL,
      daily_orders INTEGER, total_order INTEGER, total_listings INTEGER,
      listing_count INTEGER, listing_pv_sum INTEGER,
      overdue INTEGER, logistics INTEGER,
      promo_ongoing INTEGER,
      finance_earning REAL, finance_fees REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_code, day)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_daily_code ON shop_daily(shop_code);
    CREATE INDEX IF NOT EXISTS idx_shop_daily_day ON shop_daily(day);
    CREATE TABLE IF NOT EXISTS shop_meta (
      shop_code TEXT PRIMARY KEY,
      shop_id TEXT, shop_name TEXT, region TEXT,
      has_4seller INTEGER NOT NULL DEFAULT 0,
      fourseller_uid TEXT, fourseller_shopid TEXT,
      report_token TEXT,
      first_seen TEXT, last_seen TEXT
    );
  `);
  // Cột thêm dần (Phase 2 4Seller) — ALTER an toàn, bỏ qua nếu đã có
  for (const col of ["promo_flash INTEGER", "promo_discount INTEGER", "has_4seller INTEGER",
    "rec_delist INTEGER", "rec_flash INTEGER", "rec_video INTEGER", "rec_at TEXT"]) {
    try { d.exec(`ALTER TABLE shop_daily ADD COLUMN ${col}`); } catch { /* đã có */ }
  }
  for (const col of ["shop_id TEXT", "fourseller_uid TEXT", "fourseller_shopid TEXT"]) {
    try { d.exec(`ALTER TABLE shop_meta ADD COLUMN ${col}`); } catch { /* đã có */ }
  }
  _db = d;
  return d;
}

/** Đảm bảo có dòng (code, day) rồi cập nhật các cột theo `patch` (chỉ cột != undefined). */
function upsertDaily(code: string, day: string, patch: Record<string, any>): void {
  const d = db();
  d.prepare(
    `INSERT OR IGNORE INTO shop_daily (shop_code, day, updated_at) VALUES (?, ?, ?)`
  ).run(code, day, new Date().toISOString());
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (cols.length) {
    const set = cols.map((c) => `${c} = @${c}`).join(", ");
    d.prepare(`UPDATE shop_daily SET ${set}, updated_at = @updated_at WHERE shop_code = @code AND day = @day`)
      .run({ ...patch, code, day, updated_at: new Date().toISOString() });
  }
}

function touchMeta(code: string, shop_name?: any, region?: any, shop_id?: any): void {
  const d = db();
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO shop_meta (shop_code, shop_id, shop_name, region, first_seen, last_seen)
     VALUES (@code, @sid, @name, @region, @now, @now)
     ON CONFLICT(shop_code) DO UPDATE SET
       shop_id = COALESCE(excluded.shop_id, shop_id),
       shop_name = COALESCE(excluded.shop_name, shop_name),
       region = COALESCE(excluded.region, region),
       last_seen = @now`
  ).run({ code, sid: shop_id != null ? String(shop_id) : null, name: shop_name ?? null, region: region ?? null, now });
}

/** Backfill shop_meta từ store "latest" cũ (data/tikcrm/shops/*.json) — chạy 1 lần để có đủ shop cho map 4Seller. */
export function backfillMetaFromShops(): number {
  const dir = path.resolve(process.cwd(), "data", "tikcrm", "shops");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = fs.readJsonSync(path.join(dir, f));
      const p = raw && typeof raw.payload === "object" ? raw.payload : raw; // file cũ lưu nested {..,payload}
      const code = p.shop_code || p.shop_id;
      if (code) { touchMeta(String(code), p.shop_name, p.region, p.shop_id); n++; }
    } catch { /* skip */ }
  }
  return n;
}

/**
 * Ghi archive theo ngày + cập nhật index. Gọi song song với store "latest".
 * `kind` ∈ health | listings | orderstatus | finance | promotion.
 */
export function recordDaily(kind: string, body: { payload?: any }): void {
  try {
    const k = safeKind(kind);
    const p = body?.payload ?? {};
    const code = safeCode(p.shop_code || p.shop_id);
    if (code === "unknown") return;
    const day = dayKey();

    // 1. archive JSON
    const dir = path.join(ROOT, code, day);
    fs.ensureDirSync(dir);
    fs.writeFileSync(path.join(dir, k + ".json"), JSON.stringify({ received_at: new Date().toISOString(), ...p }));

    // 2. index — mỗi kind cập nhật cột của mình
    touchMeta(code, p.shop_name, p.region, p.shop_id);
    const patch: Record<string, any> = { shop_name: p.shop_name ?? undefined, region: p.region ?? undefined };

    if (k === "health") {
      patch.shop_status = p.shop_status;
      patch.assessment_level = p.assessment_current_level != null ? Number(p.assessment_current_level) : undefined;
      patch.violation_score = num(p.violation_score) ?? undefined;
      patch.net_earnings = num(p.net_earnings) ?? undefined;
      patch.on_hold = num(p.on_hold) ?? undefined;
      patch.total_holding = num(p.total_holding) ?? undefined;
      patch.daily_orders = num(p.daily_orders) ?? undefined;
      patch.total_order = num(p.total_order) ?? undefined;
      patch.total_listings = num(p.total_listings_active) ?? undefined;
    } else if (k === "listings") {
      const arr = Array.isArray(p.listings) ? p.listings : [];
      patch.listing_count = p.total_product_count != null ? Number(p.total_product_count) : arr.length;
      patch.listing_pv_sum = arr.reduce((a: number, x: any) => a + (Number(x.pv_28d) || 0), 0);
    } else if (k === "orderstatus") {
      const cols = Array.isArray(p.columns) ? p.columns : [];
      const find = (re: RegExp) => cols.find((c: any) => re.test(String(c.title || "")))?.count;
      patch.overdue = num(find(/overdue/i)) ?? 0;
      patch.logistics = num(find(/logistic/i)) ?? 0;
    } else if (k === "finance") {
      patch.finance_earning = num(p.sums?.earning) ?? undefined;
      patch.finance_fees = num(p.sums?.fees) ?? undefined;
    } else if (k === "promotion") {
      const qi = Array.isArray(p.summary?.quantity_info) ? p.summary.quantity_info : [];
      const ongoing = qi.find((x: any) => Number(x.promotion_status) === 2)?.quantity;
      patch.promo_ongoing = ongoing != null ? Number(ongoing) : undefined;
    } else if (k === "fourseller") {
      patch.has_4seller = 1;
      patch.promo_flash = p.promo_flash != null ? Number(p.promo_flash) : undefined;
      patch.promo_discount = p.promo_discount != null ? Number(p.promo_discount) : undefined;
    } else if (k === "recommendations") {
      patch.rec_delist = Array.isArray(p.xoa) ? p.xoa.length : undefined;
      patch.rec_flash = Array.isArray(p.flash) ? p.flash.length : undefined;
      patch.rec_video = Array.isArray(p.video) ? p.video.length : undefined;
      patch.rec_at = new Date().toISOString();
    }
    upsertDaily(code, day, patch);
  } catch (e: any) {
    console.warn(`[dailyStore] ${kind} lỗi: ${e?.message ?? e}`);
  }
}

/** Danh sách shop đã biết (từ meta) để đối chiếu với 4Seller. */
export function listMetaShops(): { shop_code: string; shop_id: string | null; shop_name: string | null; has_4seller: number }[] {
  return db().prepare(`SELECT shop_code, shop_id, shop_name, has_4seller FROM shop_meta`).all() as any[];
}

/** Lấy mapping 4Seller của 1 shop (null nếu chưa map). */
export function getShopFourSeller(code: string): { uid: string; shopId: string; shop_name: string | null } | null {
  const row = db().prepare(
    `SELECT shop_name, fourseller_uid, fourseller_shopid FROM shop_meta WHERE shop_code = ?`
  ).get(safeCode(code)) as any;
  return row?.fourseller_uid ? { uid: row.fourseller_uid, shopId: row.fourseller_shopid, shop_name: row.shop_name } : null;
}

/** Ghi mapping 4Seller cho 1 shop (uid tài khoản + shopId 4Seller). */
export function setShopFourSeller(code: string, uid: string, shopId: any): void {
  db().prepare(
    `UPDATE shop_meta SET has_4seller = 1, fourseller_uid = ?, fourseller_shopid = ? WHERE shop_code = ?`
  ).run(String(uid), String(shopId), safeCode(code));
}

/** Thống kê tổng cho dashboard TookTik (từ index SQLite). */
export function getOverview(): any {
  const d = db();
  const metaTotal = (d.prepare(`SELECT COUNT(*) c FROM shop_meta`).get() as any).c;
  const has4s = (d.prepare(`SELECT COUNT(*) c FROM shop_meta WHERE has_4seller = 1`).get() as any).c;
  // dòng mới nhất mỗi shop
  const latest = d.prepare(
    `SELECT sd.* FROM shop_daily sd
     JOIN (SELECT shop_code, MAX(day) md FROM shop_daily GROUP BY shop_code) m
       ON sd.shop_code = m.shop_code AND sd.day = m.md`
  ).all() as any[];
  const sum = (f: string) => latest.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const attention = latest
    .filter((r) => (Number(r.overdue) || 0) > 0 || (Number(r.logistics) || 0) > 0)
    .map((r) => ({ code: r.shop_code, name: r.shop_name, overdue: Number(r.overdue) || 0, logistics: Number(r.logistics) || 0 }))
    .sort((a, b) => b.overdue + b.logistics - (a.overdue + a.logistics))
    .slice(0, 25);
  return {
    meta_total: metaTotal,
    has_4seller: has4s,
    with_daily: latest.length,
    with_listings: latest.filter((r) => Number(r.listing_count) > 0).length,
    with_rec: latest.filter((r) => r.rec_at).length,
    rec_totals: { delist: sum("rec_delist"), flash: sum("rec_flash"), video: sum("rec_video") },
    promo_totals: { flash: sum("promo_flash"), discount: sum("promo_discount") },
    order_issues: { overdue: sum("overdue"), logistics: sum("logistics") },
    attention,
  };
}

/** List mọi shop CÓ data (dòng shop_daily mới nhất) + report_token — cho dashboard fleet admin. */
export function listShopsOverview(): any[] {
  const d = db();
  return d.prepare(
    `SELECT sd.*, sm.report_token AS report_token
     FROM shop_daily sd
     JOIN (SELECT shop_code, MAX(day) md FROM shop_daily GROUP BY shop_code) m
       ON sd.shop_code = m.shop_code AND sd.day = m.md
     LEFT JOIN shop_meta sm ON sm.shop_code = sd.shop_code`
  ).all() as any[];
}

/** Token link báo cáo public của 1 shop — tạo nếu chưa có. */
export function getOrCreateReportToken(code: string): string {
  const d = db();
  const c = safeCode(code);
  const row = d.prepare(`SELECT report_token FROM shop_meta WHERE shop_code = ?`).get(c) as any;
  if (row?.report_token) return row.report_token;
  const token = crypto.randomBytes(9).toString("base64url"); // ~12 ký tự url-safe
  touchMeta(c); // đảm bảo có dòng meta
  d.prepare(`UPDATE shop_meta SET report_token = ? WHERE shop_code = ?`).run(token, c);
  return token;
}

/** token → shop_code (null nếu không hợp lệ). */
export function resolveReportToken(token: string): string | null {
  const row = db().prepare(`SELECT shop_code FROM shop_meta WHERE report_token = ?`).get(String(token)) as any;
  return row?.shop_code ?? null;
}

/** Chuỗi ngày (index) của 1 shop, mới → cũ, giới hạn limit. */
export function getDailySeries(code: string, limit = 60): any[] {
  return db()
    .prepare(`SELECT * FROM shop_daily WHERE shop_code = ? ORDER BY day DESC LIMIT ?`)
    .all(safeCode(code), limit);
}

/** Snapshot 1 ngày cụ thể (đọc file archive theo kind). */
export function getDaySnapshot(code: string, day: string): Record<string, any> {
  const dir = path.join(ROOT, safeCode(code), String(day).replace(/[^\d-]/g, ""));
  const out: Record<string, any> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) {
      try { out[f.replace(/\.json$/, "")] = fs.readJsonSync(path.join(dir, f)); } catch { /* skip */ }
    }
  }
  return out;
}

/** Snapshot <kind> MỚI NHẤT có sẵn của shop (quét ngược maxBack ngày). null nếu không có. */
export function getLatestKindSnapshot(code: string, kind: string, maxBack = 21): { day: string; data: any } | null {
  const dir = path.join(ROOT, safeCode(code));
  if (!fs.existsSync(dir)) return null;
  const days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, maxBack);
  for (const day of days) {
    const f = path.join(dir, day, safeKind(kind) + ".json");
    if (fs.existsSync(f)) { try { return { day, data: fs.readJsonSync(f) }; } catch { /* hỏng → ngày kế */ } }
  }
  return null;
}

/** Các ngày có snapshot listings của 1 shop (mới → cũ). */
export function listListingDays(code: string): string[] {
  const dir = path.join(ROOT, safeCode(code));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(dir, d, "listings.json")))
    .sort().reverse();
}

/** Xoá archive cũ hơn `keepDays` (giữ index gọn không đụng). Gọi từ cron sau. */
export function pruneOld(keepDays = 120): number {
  if (!fs.existsSync(ROOT)) return 0;
  const cutoff = dayKey(new Date(Date.now() - keepDays * 864e5));
  let removed = 0;
  for (const code of fs.readdirSync(ROOT)) {
    const shopDir = path.join(ROOT, code);
    if (!fs.statSync(shopDir).isDirectory()) continue;
    for (const day of fs.readdirSync(shopDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        fs.removeSync(path.join(shopDir, day));
        removed++;
      }
    }
  }
  return removed;
}
