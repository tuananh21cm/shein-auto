import Database from "better-sqlite3";
import fs from "fs-extra";
import path from "path";
import type { Metric, AnalysisAlert, CrawlStatus, ListingViewRow } from "./types";

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

      -- Time-series view PER-LISTING (1 dòng/shop/ngày/SP, từ route product-manage).
      -- pv_28d = last_28days_pv (cửa sổ trượt 28 ngày) → diff giữa các ngày = đà tăng/giảm view.
      CREATE TABLE IF NOT EXISTS listing_views (
        shop         TEXT NOT NULL DEFAULT '',   -- '' = run không tag shop (profile config)
        run_date     TEXT NOT NULL,
        product_id   TEXT NOT NULL,
        product_name TEXT,
        pv_28d       INTEGER,
        orders_28d   INTEGER,
        gmv_28d      REAL,
        sales_total  INTEGER,
        stock        INTEGER,
        run_id       INTEGER,
        captured_at  TEXT,
        PRIMARY KEY (shop, run_date, product_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lv_shop_date ON listing_views(shop, run_date);

      -- Snapshot phân tích MỚI NHẤT của từng shop (1 dòng/shop) — để Listings UI đọc nhanh.
      CREATE TABLE IF NOT EXISTS shop_analysis (
        shop         TEXT PRIMARY KEY,
        run_date     TEXT,
        run_id       INTEGER,
        status       TEXT,            -- crawl status: ok|partial|login_required|error
        overall      TEXT,            -- AI: good|warning|critical
        summary      TEXT,
        areas_json   TEXT,
        alerts_json  TEXT,
        metrics_json TEXT,            -- vài chỉ số headline cho UI
        report_path  TEXT,
        updated_at   INTEGER
      );
    `);
    // crawl_runs.shop — tag run theo shop (multi-shop). ALTER idempotent.
    try { this.db.exec("ALTER TABLE crawl_runs ADD COLUMN shop TEXT"); } catch { /* đã có cột */ }
  }

  startRun(runDate: string, shop?: string | null): number {
    const info = this.db
      .prepare(`INSERT INTO crawl_runs (run_date, started_at, status, shop) VALUES (?, ?, 'running', ?)`)
      .run(runDate, new Date().toISOString(), shop ?? null);
    return Number(info.lastInsertRowid);
  }

  /** Map shop → Kiki-TikTok profile (driver chạy phân tích per-shop). Bảng do EditDb tạo. */
  listShopProfiles(): { shop: string; kiki_profile: string }[] {
    try {
      return this.db
        .prepare("SELECT shop, kiki_profile FROM shop_tiktok_profile WHERE kiki_profile IS NOT NULL AND kiki_profile != ''")
        .all() as any[];
    } catch { return []; }
  }

  /** Metrics lượt mới nhất của 1 SHOP trong ngày (diff vs hôm qua theo đúng shop). */
  getMetricsByShopDate(shop: string | null, runDate: string): MetricRow[] {
    const run = (shop
      ? this.db.prepare(`SELECT id FROM crawl_runs WHERE run_date=? AND shop=? ORDER BY id DESC LIMIT 1`).get(runDate, shop)
      : this.db.prepare(`SELECT id FROM crawl_runs WHERE run_date=? AND shop IS NULL ORDER BY id DESC LIMIT 1`).get(runDate)
    ) as { id: number } | undefined;
    if (!run) return [];
    return this.db
      .prepare(`SELECT route, key, value_num as valueNum, value_text as valueText, unit FROM metrics WHERE run_id = ?`)
      .all(run.id) as MetricRow[];
  }

  upsertShopAnalysis(a: {
    shop: string; runDate: string; runId: number; status: string; overall: string;
    summary: string; areasJson: string; alertsJson: string; metricsJson: string; reportPath: string;
  }): void {
    this.db.prepare(`
      INSERT INTO shop_analysis (shop, run_date, run_id, status, overall, summary, areas_json, alerts_json, metrics_json, report_path, updated_at)
      VALUES (@shop, @runDate, @runId, @status, @overall, @summary, @areasJson, @alertsJson, @metricsJson, @reportPath, @now)
      ON CONFLICT(shop) DO UPDATE SET
        run_date=excluded.run_date, run_id=excluded.run_id, status=excluded.status, overall=excluded.overall,
        summary=excluded.summary, areas_json=excluded.areas_json, alerts_json=excluded.alerts_json,
        metrics_json=excluded.metrics_json, report_path=excluded.report_path, updated_at=excluded.updated_at
    `).run({ ...a, now: Date.now() });
  }

  listShopAnalysis(): any[] {
    return this.db.prepare("SELECT * FROM shop_analysis").all() as any[];
  }
  getShopAnalysis(shop: string): any | undefined {
    return this.db.prepare("SELECT * FROM shop_analysis WHERE shop=?").get(shop);
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

  /** Lưu snapshot view per-listing của 1 lượt cào (upsert — lượt sau trong ngày ghi đè). */
  upsertListingViews(runId: number, shop: string | null, runDate: string, rows: ListingViewRow[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO listing_views (shop, run_date, product_id, product_name, pv_28d, orders_28d, gmv_28d, sales_total, stock, run_id, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop, run_date, product_id) DO UPDATE SET
        product_name=excluded.product_name, pv_28d=excluded.pv_28d, orders_28d=excluded.orders_28d,
        gmv_28d=excluded.gmv_28d, sales_total=excluded.sales_total, stock=excluded.stock,
        run_id=excluded.run_id, captured_at=excluded.captured_at
    `);
    const tx = this.db.transaction((rs: ListingViewRow[]) => {
      for (const r of rs) {
        stmt.run(shop ?? "", runDate, r.productId, r.productName, r.pv28d, r.orders28d,
          r.gmv28d ?? null, r.salesTotal ?? null, r.stock ?? null, runId, now);
      }
    });
    tx(rows);
  }

  /**
   * Trend view per-listing của 1 shop: ngày mới nhất vs ngày liền trước vs mốc ~7 ngày.
   * - prevDate  = ngày gần nhất TRƯỚC ngày mới nhất (diff "hôm qua").
   * - weekDate  = ngày CŨ NHẤT trong cửa sổ 7 ngày trước ngày mới nhất (diff "7 ngày";
   *   cào đủ hằng ngày thì đúng 7 ngày trước, thiếu ngày thì lấy mốc xa nhất có data).
   * Trả kèm dates dùng để UI hiển thị minh bạch. pv là cửa sổ trượt 28d — diff = đà thay đổi.
   */
  getListingViewTrends(shop: string | null): {
    latestDate: string | null; prevDate: string | null; weekDate: string | null;
    rows: {
      productId: string; productName: string; stock: number | null;
      pv: number; pvPrev: number | null; dDay: number | null;
      pvWeek: number | null; dWeek: number | null; pctWeek: number | null;
      orders: number; ordersPrev: number | null; ordersWeek: number | null;
    }[];
  } {
    const key = shop ?? "";
    const dates = (this.db
      .prepare(`SELECT DISTINCT run_date FROM listing_views WHERE shop=? COLLATE NOCASE ORDER BY run_date DESC LIMIT 15`)
      .all(key) as { run_date: string }[]).map((r) => r.run_date);
    if (!dates.length) return { latestDate: null, prevDate: null, weekDate: null, rows: [] };

    const latestDate = dates[0];
    const prevDate = dates[1] ?? null;
    const dayMs = 86_400_000;
    const t0 = Date.parse(latestDate + "T00:00:00Z");
    // cũ nhất trong [latest-7 .. latest-1]; phải khác prevDate mới có ý nghĩa cột riêng
    const inWindow = dates.filter((d) => {
      const dd = (t0 - Date.parse(d + "T00:00:00Z")) / dayMs;
      return dd >= 1 && dd <= 7;
    });
    const weekDate = inWindow.length ? inWindow[inWindow.length - 1] : null;

    const fetch = (d: string | null): Map<string, any> => {
      if (!d) return new Map();
      const rs = this.db
        .prepare(`SELECT product_id, product_name, pv_28d, orders_28d, stock FROM listing_views WHERE shop=? COLLATE NOCASE AND run_date=?`)
        .all(key, d) as any[];
      return new Map(rs.map((r) => [r.product_id, r]));
    };
    const today = fetch(latestDate);
    const prev = fetch(prevDate);
    const week = fetch(weekDate === prevDate ? null : weekDate);
    if (weekDate === prevDate && prevDate) for (const [k, v] of prev) week.set(k, v);

    const rows = [...today.values()].map((r) => {
      const p = prev.get(r.product_id);
      const w = week.get(r.product_id);
      const pv = r.pv_28d ?? 0;
      const pvPrev = p ? p.pv_28d ?? 0 : null;
      const pvWeek = w ? w.pv_28d ?? 0 : null;
      return {
        productId: r.product_id, productName: r.product_name ?? "", stock: r.stock ?? null,
        pv, pvPrev, dDay: pvPrev != null ? pv - pvPrev : null,
        pvWeek, dWeek: pvWeek != null ? pv - pvWeek : null,
        pctWeek: pvWeek != null && pvWeek > 0 ? Math.round(((pv - pvWeek) / pvWeek) * 1000) / 10 : null,
        orders: r.orders_28d ?? 0,
        ordersPrev: p ? p.orders_28d ?? 0 : null,
        ordersWeek: w ? w.orders_28d ?? 0 : null,
      };
    });
    rows.sort((a, b) => b.pv - a.pv);
    return { latestDate, prevDate, weekDate, rows };
  }

  /**
   * Helper CHUNG: mỗi listing ở snapshot mới nhất kèm đà tăng view tính từ ngày ĐẦU track.
   * avgPerDay = (pv_nay − pv_ngày_đầu)/số_ngày (pv là cửa sổ trượt 28d → đây là đà thật).
   * Dùng cho cả getSlowGrowthListings (chậm→xóa) và getRisingListings (lên→scale).
   */
  private listingGrowthRows(shop: string | null): {
    latestDate: string | null; historyDays: number;
    rows: {
      productId: string; productName: string; pv: number; firstPv: number; growth: number;
      avgPerDay: number; daysTracked: number; orders: number; stock: number | null; firstDate: string;
    }[];
  } {
    const key = shop ?? "";
    const dates = (this.db
      .prepare(`SELECT DISTINCT run_date FROM listing_views WHERE shop=? COLLATE NOCASE ORDER BY run_date DESC`)
      .all(key) as { run_date: string }[]).map((r) => r.run_date);
    if (!dates.length) return { latestDate: null, historyDays: 0, rows: [] };
    const latest = dates[0];
    const dayMs = 86_400_000;
    const tLatest = Date.parse(latest + "T00:00:00Z");
    const latestRows = this.db
      .prepare(`SELECT product_id, product_name, pv_28d, orders_28d, stock FROM listing_views WHERE shop=? COLLATE NOCASE AND run_date=?`)
      .all(key, latest) as any[];
    const firstStmt = this.db.prepare(
      `SELECT run_date, pv_28d FROM listing_views WHERE shop=? COLLATE NOCASE AND product_id=? ORDER BY run_date LIMIT 1`
    );
    const rows = [] as any[];
    for (const r of latestRows) {
      const first = firstStmt.get(key, r.product_id) as any;
      if (!first) continue;
      const daysTracked = Math.round((tLatest - Date.parse(first.run_date + "T00:00:00Z")) / dayMs);
      const pv = r.pv_28d ?? 0;
      const firstPv = first.pv_28d ?? 0;
      const growth = pv - firstPv;
      rows.push({
        productId: r.product_id, productName: r.product_name ?? "", pv, firstPv, growth,
        avgPerDay: Math.round((daysTracked >= 1 ? growth / daysTracked : growth) * 10) / 10,
        daysTracked, orders: r.orders_28d ?? 0, stock: r.stock ?? null, firstDate: first.run_date,
      });
    }
    return { latestDate: latest, historyDays: dates.length, rows };
  }

  /**
   * Listing "lên CỰC CHẬM" của 1 shop — ứng viên xóa. Tiêu chí (đều chỉnh được):
   *   - đã THEO DÕI ≥ minDays ngày (tránh giết sp mới list chưa kịp ramp) — QUAN TRỌNG NHẤT.
   *   - view 28d ≤ maxPv · tốc độ tăng TB ≤ maxAvgPerDay/ngày (đứng im) · orders_28d = 0.
   * Trả kèm daysTracked + ngày đầu để user tự cân nhắc trước khi xóa (KHÔNG tự xóa).
   */
  getSlowGrowthListings(
    shop: string | null,
    opts: { maxPv?: number; minDays?: number; maxAvgPerDay?: number } = {}
  ): {
    latestDate: string | null; minDays: number; maxPv: number; maxAvgPerDay: number; historyDays: number;
    candidates: any[];
  } {
    const maxPv = opts.maxPv ?? 30;
    const minDays = opts.minDays ?? 7;
    const maxAvgPerDay = opts.maxAvgPerDay ?? 2;
    const g = this.listingGrowthRows(shop);
    const candidates = g.rows
      .filter((r) => r.daysTracked >= minDays && r.pv <= maxPv && r.orders === 0 && r.avgPerDay <= maxAvgPerDay)
      .sort((a, b) => a.pv - b.pv || a.avgPerDay - b.avgPerDay); // "chết" nhất trước
    return { latestDate: g.latestDate, minDays, maxPv, maxAvgPerDay, historyDays: g.historyDays, candidates };
  }

  /**
   * Listing "VIEW ĐANG LÊN" của 1 shop — để scale/quảng cáo/bổ hàng. Tiêu chí (chỉnh được):
   *   - đã theo dõi ≥ minDays ngày (đà tin cậy, mặc định thấp 2 để bắt sớm).
   *   - tốc độ tăng view TB ≥ minAvgPerDay/ngày.
   * Kèm cờ: converting (có đơn → nên scale) / lowStock (tồn ≤ lowStockAt → bổ hàng gấp kẻo mất sale
   * lúc đang hot). Sắp theo đà tăng mạnh nhất. Kèm summary để thống kê nhanh.
   */
  getRisingListings(
    shop: string | null,
    opts: { minAvgPerDay?: number; minDays?: number; lowStockAt?: number } = {}
  ): {
    latestDate: string | null; minDays: number; minAvgPerDay: number; lowStockAt: number; historyDays: number;
    summary: { total: number; converting: number; lowStock: number };
    risers: any[];
  } {
    const minAvgPerDay = opts.minAvgPerDay ?? 15;
    const minDays = opts.minDays ?? 2;
    const lowStockAt = opts.lowStockAt ?? 20;
    const g = this.listingGrowthRows(shop);
    const risers = g.rows
      .filter((r) => r.daysTracked >= minDays && r.avgPerDay >= minAvgPerDay)
      .map((r) => ({ ...r, converting: r.orders > 0, lowStock: r.stock != null && r.stock <= lowStockAt }))
      .sort((a, b) => b.avgPerDay - a.avgPerDay); // lên mạnh nhất trước
    const summary = {
      total: risers.length,
      converting: risers.filter((r) => r.converting).length,
      lowStock: risers.filter((r) => r.lowStock).length,
    };
    return { latestDate: g.latestDate, minDays, minAvgPerDay, lowStockAt, historyDays: g.historyDays, summary, risers };
  }

  /**
   * Chọn sản phẩm ĐƯA VÀO FLASH của 1 shop (bước 7 quy trình flash). Tiêu chí (theo yêu cầu):
   *   - GIỮ sp có ÍT NHẤT 1 tín hiệu: "có đơn" (orders_28d>0) HOẶC "đang lên" (avgPerDay≥risingPerDay)
   *     HOẶC "nhiều view" (pv_28d≥topViewPv).
   *   - → tự động NÉ sp "7 ngày tăng view ít" (không tín hiệu nào) — chúng bị loại vì reasons rỗng.
   * Sắp ưu tiên: có đơn trước → đà tăng mạnh → view cao. Cap `limit` (mặc định 30).
   * Trả product_id (khớp id trong màn Select Products của flash) + lý do chọn để minh bạch.
   */
  getFlashCandidates(
    shop: string | null,
    opts: { limit?: number; risingPerDay?: number; topViewPv?: number } = {}
  ): {
    latestDate: string | null; historyDays: number; limit: number; total: number;
    candidates: {
      productId: string; productName: string; pv: number; avgPerDay: number; daysTracked: number;
      orders: number; stock: number | null; converting: boolean; reasons: string[];
    }[];
  } {
    const limit = opts.limit ?? 30;
    const risingPerDay = opts.risingPerDay ?? 15;
    const topViewPv = opts.topViewPv ?? 500;
    const g = this.listingGrowthRows(shop);
    const qualified = g.rows
      .map((r) => {
        const reasons: string[] = [];
        if (r.orders > 0) reasons.push("có đơn");
        if (r.avgPerDay >= risingPerDay) reasons.push("đang lên");
        if (r.pv >= topViewPv) reasons.push("nhiều view");
        return { ...r, converting: r.orders > 0, reasons };
      })
      .filter((r) => r.reasons.length > 0) // ≥1 tín hiệu → né sp 7d-tăng-ít (không tín hiệu)
      // có đơn trước → đà mạnh → view cao
      .sort((a, b) => (b.converting ? 1 : 0) - (a.converting ? 1 : 0) || b.avgPerDay - a.avgPerDay || b.pv - a.pv);
    return {
      latestDate: g.latestDate, historyDays: g.historyDays, limit, total: qualified.length,
      candidates: qualified.slice(0, limit).map((r) => ({
        productId: r.productId, productName: r.productName, pv: r.pv, avgPerDay: r.avgPerDay,
        daysTracked: r.daysTracked, orders: r.orders, stock: r.stock, converting: r.converting, reasons: r.reasons,
      })),
    };
  }

  getAlertsByRun(runId: number): AnalysisAlert[] {
    return this.db
      .prepare(`SELECT severity, title, detail, action FROM alerts WHERE run_id = ?`)
      .all(runId) as AnalysisAlert[];
  }

  /** Danh sách shop có data listing_views (dropdown Video Studio). */
  listTrackedShops(): string[] {
    return (this.db
      .prepare(`SELECT DISTINCT shop FROM listing_views WHERE shop != '' ORDER BY shop`)
      .all() as { shop: string }[]).map((r) => r.shop);
  }

  close(): void {
    this.db.close();
  }
}
