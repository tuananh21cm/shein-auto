/**
 * videoDb — state của Video Studio: mỗi row = 1 video của 1 sản phẩm.
 * Status flow: queued → generating → ready | error ; ready → posted (user đánh dấu).
 * 1 sản phẩm có thể nhiều video (regen = row mới, seed mới).
 * hook_style lưu để A/B test: đối chiếu kịch bản hook ↔ retention/đơn.
 * DB riêng data/videos.db (không đụng data/tiktok.db của crawler).
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs-extra";

const DB_PATH = path.join(process.cwd(), "data", "videos.db");

export type VideoStatus = "queued" | "generating" | "ready" | "error" | "posted";

export interface VideoRow {
  id: number;
  shop: string;
  product_id: string;
  listing_id: string;
  title: string;
  status: VideoStatus;
  step: string | null;        // step hiện tại/step fail: images|script|tts|render
  file: string | null;        // path mp4 khi ready
  script_json: string | null;
  voice: string | null;
  hook_style: string | null;  // kịch bản hook (social_proof/viral/tease/...)
  seed: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  posted_at: number | null;
}

export class VideoDb {
  db: Database.Database;

  constructor(file: string = DB_PATH) {
    if (file !== ":memory:") fs.ensureDirSync(path.dirname(file));
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        shop        TEXT NOT NULL,
        product_id  TEXT NOT NULL,
        listing_id  TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'queued',
        step        TEXT,
        file        TEXT,
        script_json TEXT,
        voice       TEXT,
        hook_style  TEXT,
        seed        TEXT NOT NULL,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        posted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_videos_shop ON videos(shop);
      CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
      CREATE INDEX IF NOT EXISTS idx_videos_product ON videos(product_id);
    `);
  }

  create(v: { shop: string; productId: string; listingId: string; title: string; seed: string; hookStyle?: string }): number {
    const now = Date.now();
    const r = this.db.prepare(
      `INSERT INTO videos (shop, product_id, listing_id, title, seed, hook_style, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(v.shop, v.productId, v.listingId, v.title, v.seed, v.hookStyle ?? null, now, now);
    return Number(r.lastInsertRowid);
  }

  get(id: number): VideoRow | undefined {
    return this.db.prepare(`SELECT * FROM videos WHERE id=?`).get(id) as VideoRow | undefined;
  }

  /** Update status + các field kèm theo. error: null = xóa error cũ (retry). */
  setStatus(id: number, u: { status: VideoStatus; step?: string; error?: string | null; file?: string; voice?: string }): void {
    this.db.prepare(
      `UPDATE videos SET status=?,
         step=COALESCE(?, step),
         error=CASE WHEN ? THEN NULL ELSE COALESCE(?, error) END,
         file=COALESCE(?, file),
         voice=COALESCE(?, voice),
         updated_at=?
       WHERE id=?`
    ).run(u.status, u.step ?? null, u.error === null ? 1 : 0, u.error ?? null, u.file ?? null, u.voice ?? null, Date.now(), id);
  }

  setScript(id: number, json: string): void {
    this.db.prepare(`UPDATE videos SET script_json=?, updated_at=? WHERE id=?`).run(json, Date.now(), id);
  }

  list(f: { shop?: string; status?: string; limit?: number } = {}): VideoRow[] {
    const conds: string[] = [], args: any[] = [];
    if (f.shop) { conds.push("shop=?"); args.push(f.shop); }
    if (f.status) { conds.push("status=?"); args.push(f.status); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM videos ${where} ORDER BY id DESC LIMIT ?`
    ).all(...args, f.limit ?? 200) as VideoRow[];
  }

  /** Sản phẩm đã có video hoàn chỉnh chưa (ready hoặc posted). */
  hasReadyVideo(productId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM videos WHERE product_id=? AND status IN ('ready','posted') LIMIT 1`
    ).get(productId);
  }

  markPosted(id: number): void {
    this.db.prepare(`UPDATE videos SET status='posted', posted_at=?, updated_at=?, error=NULL WHERE id=?`)
      .run(Date.now(), Date.now(), id);
  }

  /** Lỗi khi auto-publish (giữ status ready để retry đăng lại). */
  setPostError(id: number, error: string): void {
    this.db.prepare(`UPDATE videos SET error=?, updated_at=? WHERE id=?`)
      .run(error.slice(0, 500), Date.now(), id);
  }

  /** Số video đã đăng của shop trong 24h qua (quota 5/ngày/shop). */
  postedTodayCount(shop: string, sinceMs: number): number {
    return (this.db.prepare(
      `SELECT COUNT(*) c FROM videos WHERE shop=? AND status='posted' AND posted_at >= ?`
    ).get(shop, sinceMs) as any).c as number;
  }

  /** Thời điểm đăng gần nhất của shop (để giãn cách giữa 2 lần đăng). */
  lastPostedAt(shop: string): number | null {
    const r = this.db.prepare(
      `SELECT MAX(posted_at) t FROM videos WHERE shop=? AND status='posted'`
    ).get(shop) as any;
    return r?.t ?? null;
  }

  /**
   * NHẬN việc nguyên tử: đổi 1 video queued → generating và trả về nó.
   * Bắt buộc atomic vì NHIỀU TIẾN TRÌNH cùng chạy queue (script gen hàng loạt + cron
   * server) — đọc-rồi-ghi tách rời sẽ khiến 2 process cùng render 1 video.
   * Trả undefined nếu không còn video queued.
   */
  claimNextQueued(): VideoRow | undefined {
    const row = this.db.prepare(
      `UPDATE videos SET status='generating', step='images', updated_at=?
       WHERE id = (SELECT id FROM videos WHERE status='queued' ORDER BY id LIMIT 1)
       RETURNING *`
    ).get(Date.now()) as VideoRow | undefined;
    return row;
  }

  /** Video ready cũ nhất của shop chưa đăng (FIFO) — ứng viên đăng tiếp theo. */
  nextReadyForShop(shop: string): VideoRow | undefined {
    return this.db.prepare(
      `SELECT * FROM videos WHERE shop=? AND status='ready' ORDER BY id LIMIT 1`
    ).get(shop) as VideoRow | undefined;
  }

  /** Các shop đang có video ready chờ đăng. */
  shopsWithReady(): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT shop FROM videos WHERE status='ready' ORDER BY shop`
    ).all() as { shop: string }[]).map((r) => r.shop);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM videos WHERE id=?`).run(id);
  }

  close(): void { this.db.close(); }
}
