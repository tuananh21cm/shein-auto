/**
 * editDb — lưu product_id của listing TikTok Shop ĐÃ auto-edit (apply suggestions) để DEDUP.
 * Vì sản phẩm list liên tục vào shop → cần biết id nào đã sửa, tránh sửa lại.
 * Dùng data/tiktok.db (chung với crawler analytics).
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "tiktok.db");

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

  close(): void {
    this.db.close();
  }
}
