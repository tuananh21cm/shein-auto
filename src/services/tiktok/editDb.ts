/**
 * editDb — lưu product_id của listing TikTok Shop ĐÃ auto-edit (apply suggestions) để DEDUP.
 * Vì sản phẩm list liên tục vào shop → cần biết id nào đã sửa, tránh sửa lại.
 * Dùng data/tiktok.db (chung với crawler analytics).
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "tiktok.db");

const safeParse = (s: any): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};

export class EditDb {
  db: Database.Database;
  constructor(file: string = DB_PATH) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edited_listings (
        product_id TEXT PRIMARY KEY,
        shop       TEXT,
        edited_at  INTEGER NOT NULL,
        applied    TEXT,                 -- JSON các phần đã apply: ["title","search_terms","attributes","highlights"]
        status     TEXT NOT NULL DEFAULT 'edited',  -- edited | failed | skipped
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edited_at ON edited_listings(edited_at DESC);
      CREATE INDEX IF NOT EXISTS idx_edited_shop ON edited_listings(shop);

      -- Map shop (tên 4Seller) → Kiki profile đã LOGIN TIKTOK SELLER CENTER của shop đó.
      -- KHÁC shop_niche.kiki_profile (profile login SHEIN để cào). Auto-edit dùng bảng này.
      CREATE TABLE IF NOT EXISTS shop_tiktok_profile (
        shop          TEXT PRIMARY KEY,
        kiki_profile  TEXT,
        updated_at    INTEGER NOT NULL
      );
    `);
  }

  /** Đã edit thành công chưa? (chỉ tính status='edited') */
  isEdited(productId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM edited_listings WHERE product_id=? AND status='edited'").get(productId);
  }

  mark(productId: string, opts: { shop?: string; applied?: string[]; status?: string; error?: string }): void {
    this.db.prepare(
      `INSERT INTO edited_listings (product_id, shop, edited_at, applied, status, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id) DO UPDATE SET
         shop=excluded.shop, edited_at=excluded.edited_at, applied=excluded.applied,
         status=excluded.status, error=excluded.error`
    ).run(
      productId,
      opts.shop ?? null,
      Date.now(),
      JSON.stringify(opts.applied ?? []),
      opts.status ?? "edited",
      opts.error ?? null
    );
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM edited_listings WHERE status='edited'").get() as any).c;
  }

  recent(n = 20): any[] {
    return this.db.prepare("SELECT * FROM edited_listings ORDER BY edited_at DESC LIMIT ?").all(n);
  }

  /** Listing đã chạy suggestion (mọi status), lọc theo shop nếu truyền. applied parse sẵn thành mảng. */
  listEdited(opts: { shop?: string; status?: string; limit?: number } = {}): any[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.shop) { where.push("shop = ?"); params.push(opts.shop); }
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const rows = this.db
      .prepare(`SELECT product_id, shop, edited_at, applied, status, error FROM edited_listings ${whereSql} ORDER BY edited_at DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map((r) => ({ ...r, applied: safeParse(r.applied) }));
  }

  /** Đếm listing đã edit/fail theo từng shop (shop NULL gom vào "(chưa gán)"). */
  countsByShop(): { shop: string; edited: number; failed: number; total: number }[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(shop, '') AS shop,
             SUM(status='edited') AS edited,
             SUM(status='failed') AS failed,
             COUNT(*) AS total
      FROM edited_listings GROUP BY COALESCE(shop, '')
    `).all() as any[];
    return rows.map((r) => ({ shop: r.shop, edited: r.edited ?? 0, failed: r.failed ?? 0, total: r.total ?? 0 }));
  }

  /* ── Map shop → Kiki profile TikTok Seller Center ── */
  allProfiles(): { shop: string; kiki_profile: string; updated_at: number }[] {
    return this.db.prepare("SELECT shop, kiki_profile, updated_at FROM shop_tiktok_profile").all() as any[];
  }

  getProfile(shop: string): string | null {
    const r = this.db.prepare("SELECT kiki_profile FROM shop_tiktok_profile WHERE shop=?").get(shop) as any;
    return r?.kiki_profile ?? null;
  }

  /** Lưu/đổi profile cho shop. profile rỗng = xoá mapping. */
  setProfile(shop: string, kikiProfile: string): void {
    const p = (kikiProfile || "").trim();
    if (!p) { this.db.prepare("DELETE FROM shop_tiktok_profile WHERE shop=?").run(shop); return; }
    this.db.prepare(`
      INSERT INTO shop_tiktok_profile (shop, kiki_profile, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(shop) DO UPDATE SET kiki_profile=excluded.kiki_profile, updated_at=excluded.updated_at
    `).run(shop, p, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
