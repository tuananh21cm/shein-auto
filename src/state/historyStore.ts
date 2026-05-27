import { eventBus } from "./eventBus";
import { getDb } from "./db";

export type HistoryStatus = "success" | "fail";

export interface HistoryEntry {
  id: string;
  file: string;
  folder: string;
  profile: string;
  status: HistoryStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  errorMessage?: string;
}

const MAX_ENTRIES = 500;

interface HistoryRow {
  id: string;
  file: string;
  folder: string;
  profile: string;
  status: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  error_message: string | null;
}

const rowToEntry = (row: HistoryRow): HistoryEntry => ({
  id: row.id,
  file: row.file,
  folder: row.folder,
  profile: row.profile,
  status: row.status as HistoryStatus,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  durationMs: row.duration_ms,
  errorMessage: row.error_message ?? undefined,
});

export const historyStore = {
  async init(): Promise<void> {
    // DB init đã được bootstrap gọi; tạo connection lười.
    getDb();
  },

  async add(entry: Omit<HistoryEntry, "id">): Promise<HistoryEntry> {
    const db = getDb();
    const id = `${entry.finishedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const full: HistoryEntry = { id, ...entry };
    db.prepare(`
      INSERT INTO history (id, file, folder, profile, status, started_at, finished_at, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      full.id,
      full.file,
      full.folder,
      full.profile,
      full.status,
      full.startedAt,
      full.finishedAt,
      full.durationMs,
      full.errorMessage ?? null
    );
    // Cap MAX_ENTRIES: xoá entry cũ nhất
    db.prepare(`
      DELETE FROM history
      WHERE id IN (
        SELECT id FROM history
        ORDER BY finished_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_ENTRIES);
    eventBus.emit("history", full);
    return full;
  },

  async list(opts?: {
    status?: HistoryStatus;
    folder?: string;
    /** Filter cho phép multi-folder (vd: scope theo user accessible shops). Nếu set kèm `folder`, intersect. */
    folders?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{ items: HistoryEntry[]; total: number }> {
    const db = getDb();
    const where: string[] = [];
    const params: any[] = [];
    if (opts?.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts?.folder) { where.push("folder = ?"); params.push(opts.folder); }
    if (opts?.folders && opts.folders.length > 0) {
      const placeholders = opts.folders.map(() => "?").join(",");
      where.push(`folder IN (${placeholders})`);
      params.push(...opts.folders);
    } else if (opts?.folders && opts.folders.length === 0) {
      // Caller có scope rỗng = không có quyền xem gì → return ngay
      return { items: [], total: 0 };
    }
    const whereSql = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

    const total = (db.prepare(`SELECT COUNT(*) as c FROM history ${whereSql}`).get(...params) as { c: number }).c;

    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = db.prepare(`
      SELECT * FROM history
      ${whereSql}
      ORDER BY finished_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as HistoryRow[];

    return { items: rows.map(rowToEntry), total };
  },

  async find(id: string): Promise<HistoryEntry | null> {
    const db = getDb();
    const row = db.prepare("SELECT * FROM history WHERE id = ?").get(id) as HistoryRow | undefined;
    return row ? rowToEntry(row) : null;
  },

  async clear(): Promise<void> {
    getDb().prepare("DELETE FROM history").run();
  },
};
