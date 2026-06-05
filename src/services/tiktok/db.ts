import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";
import type { Metric, AnalysisAlert, CrawlStatus } from "./types";

const DEFAULT_PATH = path.resolve(process.cwd(), "data", "tiktok.db");

export interface MetricRow extends Metric {
  route: string;
}

export class TiktokDb {
  private db: Database.Database;

  constructor(file: string = DEFAULT_PATH) {
    if (file !== ":memory:") fs.ensureDirSync(path.dirname(file));
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_date TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_date ON crawl_runs(run_date);

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        route TEXT NOT NULL,
        key TEXT NOT NULL,
        value_num REAL,
        value_text TEXT,
        unit TEXT,
        captured_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics(run_id);
      CREATE INDEX IF NOT EXISTS idx_metrics_key ON metrics(key);

      CREATE TABLE IF NOT EXISTS raw_captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        route TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status INTEGER,
        path TEXT
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        action TEXT
      );

      CREATE TABLE IF NOT EXISTS reports (
        run_id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  startRun(runDate: string): number {
    const info = this.db
      .prepare(`INSERT INTO crawl_runs (run_date, started_at, status) VALUES (?, ?, 'running')`)
      .run(runDate, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, status: CrawlStatus, notes?: string): void {
    this.db
      .prepare(`UPDATE crawl_runs SET finished_at = ?, status = ?, notes = ? WHERE id = ?`)
      .run(new Date().toISOString(), status, notes ?? null, runId);
  }

  insertMetrics(runId: number, route: string, metrics: Metric[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO metrics (run_id, route, key, value_num, value_text, unit, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction((rows: Metric[]) => {
      for (const m of rows) {
        stmt.run(runId, route, m.key, m.valueNum ?? null, m.valueText ?? null, m.unit ?? null, now);
      }
    });
    tx(metrics);
  }

  insertRawCapture(runId: number, route: string, endpoint: string, status: number, filePath?: string): void {
    this.db
      .prepare(`INSERT INTO raw_captures (run_id, route, endpoint, status, path) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, route, endpoint, status, filePath ?? null);
  }

  insertAlerts(runId: number, alerts: AnalysisAlert[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO alerts (run_id, severity, title, detail, action) VALUES (?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction((rows: AnalysisAlert[]) => {
      for (const a of rows) stmt.run(runId, a.severity, a.title, a.detail ?? null, a.action ?? null);
    });
    tx(alerts);
  }

  insertReport(runId: number, reportPath: string, model: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO reports (run_id, path, model, created_at) VALUES (?, ?, ?, ?)`)
      .run(runId, reportPath, model, new Date().toISOString());
  }

  /** Lấy metrics của lượt MỚI NHẤT trong ngày `runDate` (dùng cho diff). */
  getMetricsByDate(runDate: string): MetricRow[] {
    const run = this.db
      .prepare(`SELECT id FROM crawl_runs WHERE run_date = ? ORDER BY id DESC LIMIT 1`)
      .get(runDate) as { id: number } | undefined;
    if (!run) return [];
    const rows = this.db
      .prepare(`SELECT route, key, value_num as valueNum, value_text as valueText, unit FROM metrics WHERE run_id = ?`)
      .all(run.id) as MetricRow[];
    return rows;
  }

  getAlertsByRun(runId: number): AnalysisAlert[] {
    return this.db
      .prepare(`SELECT severity, title, detail, action FROM alerts WHERE run_id = ?`)
      .all(runId) as AnalysisAlert[];
  }

  close(): void {
    this.db.close();
  }
}
