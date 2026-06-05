# TikTok Shop US — Seller Crawler & AI Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cào dữ liệu seller center TikTok Shop US hằng ngày qua profile Kiki đã đăng nhập, lưu snapshot vào SQLite, và dùng Claude phân tích → báo cáo Markdown kèm alert/việc cần làm.

**Architecture:** Tái dùng pattern Kiki (start profile → CDP → Playwright `connectOverCDP` → passive intercept JSON BFF, y như `storeCrawler.ts`/`detailSignals.ts`). 1 session đi lần lượt qua registry route (Homepage + Compass v1), mỗi route có extractor bóc chỉ số bằng `deepFind` (bền với đổi tên endpoint). Snapshot → SQLite long-format → Claude phân tích → Markdown report. Cron 1 lần/ngày theo pattern `researchCron`.

**Tech Stack:** TypeScript + tsx, playwright-core, better-sqlite3 (đã có), node-cron (đã có), `@anthropic-ai/sdk` (thêm mới), vitest (test runner — thêm mới).

**Spec:** `docs/superpowers/specs/2026-06-06-tiktok-seller-crawler-design.md`

> **Quy ước commit:** mỗi commit message kết thúc bằng dòng trailer:
> `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
> (đã lược trong các block bên dưới cho gọn — nhớ thêm khi commit thật).

---

## File Structure

**Create:**
- `config/tiktok.json` — cấu hình profile/cron/model.
- `src/services/tiktok/types.ts` — `Capture`, `Metric`, `RouteMetrics`, `RouteDef`, `CrawlSnapshot`, `AnalysisResult`.
- `src/services/tiktok/deepFind.ts` — `deepFind`, `deepFindFirst`, `toNum` (helper bóc số bền với schema đổi).
- `src/services/tiktok/captureBus.ts` — gắn `response` listener, gom JSON BFF; discovery dump.
- `src/services/tiktok/extractors/homepage.ts` — bóc chỉ số trang `/homepage`.
- `src/services/tiktok/extractors/compassOverview.ts` — bóc chỉ số Compass overview.
- `src/services/tiktok/routes.ts` — registry route v1.
- `src/services/tiktok/db.ts` — wrapper better-sqlite3 cho `data/tiktok.db`.
- `src/services/anthropic/client.ts` — wrapper Claude API.
- `src/services/tiktok/analyze.ts` — build prompt, parse, gọi Claude.
- `src/services/tiktok/renderReport.ts` — render Markdown (thuần, test được).
- `src/core/crawlTiktokSeller.ts` — orchestrator 1 lượt.
- `src/core/tiktokCron.ts` — `runTiktokJob` + `scheduleTiktokCron`.
- `src/scripts/crawlTiktok.ts` — entrypoint chạy tay (`--discover`, `--no-ai`).
- Test co-located `*.test.ts` cạnh module tương ứng.

**Modify:**
- `package.json` — thêm deps + script `test`.
- `src/config/appConfig.ts` — thêm `tiktokConfig()` + interface.
- `src/index.ts` — gọi `scheduleTiktokCron()`.
- `.gitignore` — bỏ qua `data/tiktok.db`, `data/_tiktok_discovery/`.
- `.env` — thêm `ANTHROPIC_API_KEY` (không commit).

---

## Task 0: Setup deps + test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Cài deps**

Run:
```bash
npm i @anthropic-ai/sdk
npm i -D vitest
```
Expected: cả hai vào `package.json`, không lỗi.

- [ ] **Step 2: Thêm script test vào `package.json`**

Trong block `"scripts"`, thêm:
```json
    "test": "vitest run",
    "test:watch": "vitest",
    "crawl:tiktok": "tsx src/scripts/crawlTiktok.ts"
```

- [ ] **Step 3: Tạo `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Cập nhật `.gitignore`**

Thêm các dòng (nếu chưa có):
```
data/tiktok.db
data/tiktok.db-*
data/_tiktok_discovery/
```

- [ ] **Step 5: Smoke test runner**

Run: `npx vitest run`
Expected: "No test files found" (chưa có test) — runner chạy OK, exit 0 hoặc thông báo no tests. Không lỗi cài đặt.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts .gitignore
git commit -m "chore: add vitest + anthropic sdk for tiktok crawler"
```

---

## Task 1: Types + deepFind helper

**Files:**
- Create: `src/services/tiktok/types.ts`
- Create: `src/services/tiktok/deepFind.ts`
- Test: `src/services/tiktok/deepFind.test.ts`

- [ ] **Step 1: Viết `types.ts`**

```ts
/** Một response JSON nội bộ TikTok seller center đã hứng được. */
export interface Capture {
  url: string;
  status: number;
  body: any;
}

/** Một chỉ số chuẩn hoá (long-format). */
export interface Metric {
  key: string;                 // 'gmv', 'orders', 'conversion_rate', 'alert_count'...
  valueNum?: number | null;
  valueText?: string | null;
  unit?: string | null;        // 'USD', '%', 'count'...
}

/** Kết quả bóc của 1 route. */
export interface RouteMetrics {
  route: string;
  metrics: Metric[];
  ok: boolean;
  error?: string;
}

/** Khai báo 1 route trong registry. */
export interface RouteDef {
  key: string;
  url: string;
  waitForSelector?: string;
  settleMs?: number;
  /** Bóc chỉ số từ captures của route. Thuần, không phụ thuộc browser. */
  extractor: (caps: Capture[]) => Metric[];
}

export type CrawlStatus = "ok" | "partial" | "login_required" | "error";

export interface CrawlSnapshot {
  runId: number;
  runDate: string;             // 'YYYY-MM-DD'
  startedAt: string;           // ISO
  finishedAt: string;          // ISO
  status: CrawlStatus;
  routes: RouteMetrics[];
  notes?: string;
}

export interface AnalysisAlert {
  severity: "high" | "medium" | "low";
  title: string;
  detail?: string;
  action?: string;
}
export interface AnalysisTodo {
  priority: number;
  task: string;
  why?: string;
}
export interface AnalysisResult {
  summary: string;
  alerts: AnalysisAlert[];
  strengths: string[];
  weaknesses: string[];
  todos: AnalysisTodo[];
}
```

- [ ] **Step 2: Viết test thất bại cho `deepFind`**

Tạo `src/services/tiktok/deepFind.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deepFind, deepFindFirst, toNum } from "./deepFind";

describe("deepFind", () => {
  it("tìm key lồng sâu", () => {
    const o = { a: { b: { gmv: 1234 } } };
    expect(deepFind(o, "gmv")).toBe(1234);
  });
  it("trả undefined khi không thấy", () => {
    expect(deepFind({ a: 1 }, "nope")).toBeUndefined();
  });
});

describe("deepFindFirst", () => {
  it("lấy key đầu tiên khớp trong danh sách ứng viên", () => {
    const o = { stats: { order_cnt: 50 } };
    expect(deepFindFirst(o, ["orders", "order_count", "order_cnt"])).toBe(50);
  });
});

describe("toNum", () => {
  it("parse số có ký tự tiền tệ/phẩy", () => {
    expect(toNum("$1,234.5")).toBe(1234.5);
  });
  it("parse phần trăm", () => {
    expect(toNum("12.3%")).toBe(12.3);
  });
  it("trả null cho rác", () => {
    expect(toNum("N/A")).toBeNull();
  });
  it("nhận object {amount}", () => {
    expect(toNum({ amount: "9.99" })).toBe(9.99);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/deepFind.test.ts`
Expected: FAIL — "Cannot find module './deepFind'".

- [ ] **Step 4: Viết `deepFind.ts`**

```ts
/** Tìm đệ quy value đầu tiên non-empty cho `key`. Port từ detailSignals.ts. */
export function deepFind(o: any, key: string, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 8) return undefined;
  if (o[key] !== undefined && o[key] !== null && o[key] !== "") return o[key];
  for (const k of Object.keys(o)) {
    const r = deepFind(o[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Thử lần lượt nhiều tên key ứng viên, trả match đầu tiên. */
export function deepFindFirst(o: any, keys: string[]): any {
  for (const k of keys) {
    const v = deepFind(o, k);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Parse số từ nhiều dạng: "$1,234.5", "12.3%", {amount}, number. */
export function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    return toNum(v.amount ?? v.usdAmount ?? v.value ?? v.val);
  }
  const s = String(v).replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 5: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/deepFind.test.ts`
Expected: PASS (3 suites).

- [ ] **Step 6: Commit**

```bash
git add src/services/tiktok/types.ts src/services/tiktok/deepFind.ts src/services/tiktok/deepFind.test.ts
git commit -m "feat(tiktok): types + deepFind helpers"
```

---

## Task 2: captureBus

**Files:**
- Create: `src/services/tiktok/captureBus.ts`
- Test: `src/services/tiktok/captureBus.test.ts`

- [ ] **Step 1: Viết test thất bại cho hàm lọc `isSellerJson`**

`src/services/tiktok/captureBus.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isSellerJson } from "./captureBus";

describe("isSellerJson", () => {
  it("giữ JSON từ API seller-us", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/api/v1/homepage/data", "application/json")).toBe(true);
  });
  it("giữ JSON từ BFF host", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/bff/compass/overview", "application/json; charset=utf-8")).toBe(true);
  });
  it("bỏ asset không phải json", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/static/app.js", "application/javascript")).toBe(false);
  });
  it("bỏ host ngoài", () => {
    expect(isSellerJson("https://www.google-analytics.com/collect", "application/json")).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/captureBus.test.ts`
Expected: FAIL — "Cannot find module './captureBus'".

- [ ] **Step 3: Viết `captureBus.ts`**

```ts
import type { Page } from "playwright-core";
import fs from "fs-extra";
import path from "path";
import type { Capture } from "./types";

/** Chỉ giữ response JSON từ domain seller TikTok (API/BFF nội bộ). */
export function isSellerJson(url: string, contentType: string): boolean {
  if (!/json/i.test(contentType)) return false;
  if (!/seller-us\.tiktok\.com|tiktokglobalshop\.com|\/api\/|\/bff\//i.test(url)) return false;
  // loại tracking/log endpoint phổ biến
  if (/google-analytics|doubleclick|\/monitor\/|\/log\/|\/track/i.test(url)) return false;
  return true;
}

export interface CaptureBusOptions {
  /** Nếu set → ghi mỗi capture ra đĩa (discovery mode). */
  dumpDir?: string;
  /** Tên route hiện tại (để đặt thư mục dump). */
  routeKey?: string;
}

export interface CaptureBus {
  snapshot(): Capture[];
  clear(): void;
  detach(): void;
  setRoute(key: string): void;
  count(): number;
}

/** Gắn listener response. Gọi TRƯỚC page.goto. */
export function attachCaptureBus(page: Page, opts: CaptureBusOptions = {}): CaptureBus {
  let buffer: Capture[] = [];
  let routeKey = opts.routeKey ?? "unknown";
  let dumpSeq = 0;

  const onResp = async (res: any) => {
    try {
      const url = res.url();
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!isSellerJson(url, ct)) return;
      const text = await res.text().catch(() => "");
      if (!text) return;
      let body: any;
      try { body = JSON.parse(text); } catch { return; }
      buffer.push({ url, status: res.status(), body });

      if (opts.dumpDir) {
        const dir = path.join(opts.dumpDir, routeKey);
        await fs.ensureDir(dir);
        const safe = String(++dumpSeq).padStart(3, "0");
        await fs.writeFile(
          path.join(dir, `${safe}.json`),
          JSON.stringify({ url, status: res.status(), body }, null, 2),
          "utf-8"
        );
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResp);

  return {
    snapshot: () => buffer.slice(),
    clear: () => { buffer = []; },
    detach: () => page.off("response", onResp),
    setRoute: (key: string) => { routeKey = key; dumpSeq = 0; },
    count: () => buffer.length,
  };
}
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/captureBus.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/services/tiktok/captureBus.ts src/services/tiktok/captureBus.test.ts
git commit -m "feat(tiktok): captureBus passive JSON interceptor + discovery dump"
```

---

## Task 3: SQLite db layer

**Files:**
- Create: `src/services/tiktok/db.ts`
- Test: `src/services/tiktok/db.test.ts`

- [ ] **Step 1: Viết test thất bại**

`src/services/tiktok/db.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TiktokDb } from "./db";

function freshDb() {
  return new TiktokDb(":memory:");
}

describe("TiktokDb", () => {
  it("tạo run, ghi metrics, đọc lại snapshot theo ngày", () => {
    const db = freshDb();
    const runId = db.startRun("2026-06-06");
    db.insertMetrics(runId, "homepage", [
      { key: "gmv", valueNum: 100, unit: "USD" },
      { key: "orders", valueNum: 5, unit: "count" },
    ]);
    db.finishRun(runId, "ok");

    const snap = db.getMetricsByDate("2026-06-06");
    expect(snap.find((m) => m.key === "gmv")?.valueNum).toBe(100);
    expect(snap.length).toBe(2);
  });

  it("getMetricsByDate trả [] khi chưa có ngày đó", () => {
    const db = freshDb();
    expect(db.getMetricsByDate("2000-01-01")).toEqual([]);
  });

  it("lưu alerts + report", () => {
    const db = freshDb();
    const runId = db.startRun("2026-06-06");
    db.insertAlerts(runId, [{ severity: "high", title: "GMV giảm", action: "xem ads" }]);
    db.insertReport(runId, "docs/reports/2026-06-06-tiktok.md", "claude-opus-4-8");
    const alerts = db.getAlertsByRun(runId);
    expect(alerts[0].severity).toBe("high");
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/db.test.ts`
Expected: FAIL — "Cannot find module './db'".

- [ ] **Step 3: Viết `db.ts`**

```ts
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
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/tiktok/db.ts src/services/tiktok/db.test.ts
git commit -m "feat(tiktok): SQLite db layer (runs/metrics/alerts/reports)"
```

---

## Task 4: Extractors (homepage + compass overview)

> Chiến lược: dùng `deepFindFirst` trên DANH SÁCH key ứng viên (giống `detailSignals.ts`). Danh sách key ban đầu là dự đoán hợp lý; **Task 11 (discovery) sẽ tinh chỉnh** danh sách này theo endpoint thật. Test dùng fixture tổng hợp mô phỏng shape BFF.

**Files:**
- Create: `src/services/tiktok/extractors/homepage.ts`
- Create: `src/services/tiktok/extractors/compassOverview.ts`
- Test: `src/services/tiktok/extractors/extractors.test.ts`

- [ ] **Step 1: Viết test thất bại**

`src/services/tiktok/extractors/extractors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractHomepage } from "./homepage";
import { extractCompassOverview } from "./compassOverview";
import type { Capture } from "../types";

describe("extractHomepage", () => {
  it("bóc số alert + đơn chờ xử lý", () => {
    const caps: Capture[] = [
      { url: "https://seller-us.tiktok.com/api/homepage/todo", status: 200, body: {
        data: { to_do_list: { pending_orders: 7, alert_count: 3 } } } },
    ];
    const m = extractHomepage(caps);
    expect(m.find((x) => x.key === "pending_orders")?.valueNum).toBe(7);
    expect(m.find((x) => x.key === "alert_count")?.valueNum).toBe(3);
  });

  it("không vỡ khi captures rỗng", () => {
    expect(extractHomepage([])).toEqual([]);
  });
});

describe("extractCompassOverview", () => {
  it("bóc gmv/orders/conversion", () => {
    const caps: Capture[] = [
      { url: "https://seller-us.tiktok.com/bff/compass/overview", status: 200, body: {
        data: { overview: { gmv: { amount: "1234.5" }, order_cnt: 42, conversion_rate: "2.3%" } } } },
    ];
    const m = extractCompassOverview(caps);
    expect(m.find((x) => x.key === "gmv")?.valueNum).toBe(1234.5);
    expect(m.find((x) => x.key === "orders")?.valueNum).toBe(42);
    expect(m.find((x) => x.key === "conversion_rate")?.valueNum).toBe(2.3);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/extractors/extractors.test.ts`
Expected: FAIL — "Cannot find module './homepage'".

- [ ] **Step 3: Viết `homepage.ts`**

```ts
import type { Capture, Metric } from "../types";
import { deepFindFirst, toNum } from "../deepFind";

/**
 * Bóc chỉ số trang /homepage. Danh sách key ứng viên — tinh chỉnh sau discovery.
 */
export function extractHomepage(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const bodies = caps.map((c) => c.body);

  const push = (key: string, candidates: string[], unit?: string) => {
    for (const b of bodies) {
      const raw = deepFindFirst(b, candidates);
      const n = toNum(raw);
      if (n !== null) { out.push({ key, valueNum: n, unit: unit ?? null }); return; }
    }
  };

  push("pending_orders", ["pending_orders", "pendingOrders", "to_be_shipped", "unshipped_cnt"], "count");
  push("alert_count", ["alert_count", "alertCount", "notification_count", "unread_count"], "count");
  push("gmv", ["gmv", "GMV", "total_gmv", "gmv_amount"], "USD");
  push("orders", ["order_cnt", "orderCount", "orders", "order_count"], "count");

  return out;
}
```

- [ ] **Step 4: Viết `compassOverview.ts`**

```ts
import type { Capture, Metric } from "../types";
import { deepFindFirst, toNum } from "../deepFind";

/**
 * Bóc chỉ số Compass overview (GMV, đơn, traffic, conversion).
 * Key ứng viên — tinh chỉnh sau discovery.
 */
export function extractCompassOverview(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const bodies = caps.map((c) => c.body);

  const push = (key: string, candidates: string[], unit?: string) => {
    for (const b of bodies) {
      const raw = deepFindFirst(b, candidates);
      const n = toNum(raw);
      if (n !== null) { out.push({ key, valueNum: n, unit: unit ?? null }); return; }
    }
  };

  push("gmv", ["gmv", "GMV", "total_gmv", "gmv_amount", "revenue"], "USD");
  push("orders", ["order_cnt", "orderCount", "orders", "order_count", "paid_order_cnt"], "count");
  push("visitors", ["visitor_cnt", "visitors", "uv", "visitor_count"], "count");
  push("page_views", ["pv", "page_view", "views", "product_views"], "count");
  push("conversion_rate", ["conversion_rate", "conversionRate", "cvr", "cr"], "%");
  push("refund_rate", ["refund_rate", "refundRate", "return_rate"], "%");

  return out;
}
```

- [ ] **Step 5: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/extractors/extractors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/tiktok/extractors/
git commit -m "feat(tiktok): homepage + compass overview extractors"
```

---

## Task 5: Route registry

**Files:**
- Create: `src/services/tiktok/routes.ts`
- Test: `src/services/tiktok/routes.test.ts`

- [ ] **Step 1: Viết test thất bại**

`src/services/tiktok/routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ROUTES } from "./routes";

describe("ROUTES", () => {
  it("v1 gồm homepage + compass-overview, mỗi route có extractor", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(keys).toContain("homepage");
    expect(keys).toContain("compass-overview");
    for (const r of ROUTES) {
      expect(typeof r.extractor).toBe("function");
      expect(r.url).toMatch(/^https:\/\/seller-us\.tiktok\.com\//);
    }
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/routes.test.ts`
Expected: FAIL — "Cannot find module './routes'".

- [ ] **Step 3: Viết `routes.ts`**

```ts
import type { RouteDef } from "./types";
import { extractHomepage } from "./extractors/homepage";
import { extractCompassOverview } from "./extractors/compassOverview";

/**
 * Registry route v1. Mở rộng phase sau = thêm 1 entry + 1 extractor.
 * URL Compass có thể cần tinh chỉnh path sau discovery.
 */
export const ROUTES: RouteDef[] = [
  {
    key: "homepage",
    url: "https://seller-us.tiktok.com/homepage",
    settleMs: 4000,
    extractor: extractHomepage,
  },
  {
    key: "compass-overview",
    url: "https://seller-us.tiktok.com/compass/overview",
    settleMs: 5000,
    extractor: extractCompassOverview,
  },
];
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tiktok/routes.ts src/services/tiktok/routes.test.ts
git commit -m "feat(tiktok): route registry (homepage + compass)"
```

---

## Task 6: Anthropic client + analyze

**Files:**
- Create: `src/services/anthropic/client.ts`
- Create: `src/services/tiktok/analyze.ts`
- Test: `src/services/tiktok/analyze.test.ts`

- [ ] **Step 1: Viết `src/services/anthropic/client.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Thiếu ANTHROPIC_API_KEY trong .env");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface ClaudeCallParams {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

/** Gọi Claude, trả text. Bật prompt caching cho system (khung ổn định). */
export async function callClaude(params: ClaudeCallParams): Promise<string> {
  const model = params.model ?? "claude-opus-4-8";
  const res = await client().messages.create({
    model,
    max_tokens: params.maxTokens ?? 2048,
    system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: params.user }],
  });
  return res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}
```

- [ ] **Step 2: Viết test thất bại cho `parseAnalysis` + `analyzeSnapshot` (inject mock)**

`src/services/tiktok/analyze.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAnalysis, analyzeSnapshot } from "./analyze";
import type { CrawlSnapshot } from "./types";

describe("parseAnalysis", () => {
  it("parse JSON thuần", () => {
    const r = parseAnalysis('{"summary":"ok","alerts":[],"strengths":[],"weaknesses":[],"todos":[]}');
    expect(r.summary).toBe("ok");
  });
  it("parse JSON bọc trong ```json fence", () => {
    const r = parseAnalysis('```json\n{"summary":"x","alerts":[],"strengths":[],"weaknesses":[],"todos":[]}\n```');
    expect(r.summary).toBe("x");
  });
  it("fallback an toàn khi rác", () => {
    const r = parseAnalysis("không phải json");
    expect(r.summary).toContain("không phân tích được");
    expect(r.alerts).toEqual([]);
  });
});

describe("analyzeSnapshot", () => {
  it("dùng callClaude inject + trả AnalysisResult", async () => {
    const snap: CrawlSnapshot = {
      runId: 1, runDate: "2026-06-06", startedAt: "", finishedAt: "", status: "ok",
      routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100 }] }],
    };
    const fakeCall = async () => '{"summary":"tốt","alerts":[{"severity":"high","title":"t"}],"strengths":[],"weaknesses":[],"todos":[]}';
    const r = await analyzeSnapshot(snap, [], { callClaude: fakeCall, model: "test" });
    expect(r.summary).toBe("tốt");
    expect(r.alerts[0].severity).toBe("high");
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/analyze.test.ts`
Expected: FAIL — "Cannot find module './analyze'".

- [ ] **Step 4: Viết `analyze.ts`**

```ts
import type { CrawlSnapshot, AnalysisResult } from "./types";
import type { MetricRow } from "./db";
import { callClaude as realCallClaude } from "../anthropic/client";

const SYSTEM = `Bạn là chuyên gia vận hành TikTok Shop US. Phân tích chỉ số shop hằng ngày.
Trả về DUY NHẤT một JSON đúng schema (không markdown, không giải thích ngoài JSON):
{
  "summary": "tóm tắt 2-3 câu tình hình hôm nay",
  "alerts": [{"severity":"high|medium|low","title":"","detail":"","action":"việc cần làm"}],
  "strengths": ["điểm mạnh"],
  "weaknesses": ["điểm yếu"],
  "todos": [{"priority":1,"task":"","why":""}]
}
Ưu tiên cảnh báo chỉ số xấu đi so với hôm qua. todos sắp theo priority tăng dần (1 = gấp nhất).`;

export function buildUserPrompt(today: CrawlSnapshot, yesterday: MetricRow[]): string {
  const todayMetrics = today.routes.flatMap((r) =>
    r.metrics.map((m) => ({ route: r.route, ...m }))
  );
  return JSON.stringify(
    { today: { date: today.runDate, status: today.status, metrics: todayMetrics }, yesterday },
    null,
    2
  );
}

export function parseAnalysis(text: string): AnalysisResult {
  const empty: AnalysisResult = {
    summary: "(AI không phân tích được — chỉ có số liệu thô)",
    alerts: [], strengths: [], weaknesses: [], todos: [],
  };
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) return empty;
    const obj = JSON.parse(raw.slice(start, end + 1));
    return {
      summary: String(obj.summary ?? empty.summary),
      alerts: Array.isArray(obj.alerts) ? obj.alerts : [],
      strengths: Array.isArray(obj.strengths) ? obj.strengths : [],
      weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses : [],
      todos: Array.isArray(obj.todos) ? obj.todos : [],
    };
  } catch {
    return empty;
  }
}

export interface AnalyzeDeps {
  callClaude?: (p: { system: string; user: string; model?: string }) => Promise<string>;
  model?: string;
}

export async function analyzeSnapshot(
  today: CrawlSnapshot,
  yesterday: MetricRow[],
  deps: AnalyzeDeps = {}
): Promise<AnalysisResult> {
  const call = deps.callClaude ?? realCallClaude;
  const user = buildUserPrompt(today, yesterday);
  try {
    const text = await call({ system: SYSTEM, user, model: deps.model });
    return parseAnalysis(text);
  } catch (e: any) {
    return {
      summary: `(Lỗi gọi AI: ${e?.message ?? e})`,
      alerts: [], strengths: [], weaknesses: [], todos: [],
    };
  }
}
```

- [ ] **Step 5: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/analyze.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/anthropic/client.ts src/services/tiktok/analyze.ts src/services/tiktok/analyze.test.ts
git commit -m "feat(tiktok): claude client + snapshot analysis"
```

---

## Task 7: Markdown report renderer

**Files:**
- Create: `src/services/tiktok/renderReport.ts`
- Test: `src/services/tiktok/renderReport.test.ts`

- [ ] **Step 1: Viết test thất bại**

`src/services/tiktok/renderReport.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./renderReport";
import type { CrawlSnapshot, AnalysisResult } from "./types";

const snap: CrawlSnapshot = {
  runId: 1, runDate: "2026-06-06", startedAt: "2026-06-06T01:00:00Z",
  finishedAt: "2026-06-06T01:05:00Z", status: "ok",
  routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100, unit: "USD" }] }],
};
const analysis: AnalysisResult = {
  summary: "GMV ổn định.",
  alerts: [{ severity: "high", title: "Tỷ lệ hoàn cao", action: "kiểm tra sản phẩm A" }],
  strengths: ["traffic tăng"], weaknesses: ["conversion thấp"],
  todos: [{ priority: 1, task: "Bật ads", why: "tăng GMV" }],
};

describe("renderMarkdown", () => {
  it("render tiêu đề + summary + alert + todo", () => {
    const md = renderMarkdown(snap, analysis, []);
    expect(md).toContain("# TikTok Shop — Báo cáo 2026-06-06");
    expect(md).toContain("GMV ổn định.");
    expect(md).toContain("Tỷ lệ hoàn cao");
    expect(md).toContain("Bật ads");
    expect(md).toContain("gmv");
  });

  it("hiện Δ so hôm qua khi có số liệu cũ", () => {
    const md = renderMarkdown(snap, analysis, [{ route: "homepage", key: "gmv", valueNum: 80, unit: "USD" }]);
    expect(md).toMatch(/\+20|\+25%/);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/services/tiktok/renderReport.test.ts`
Expected: FAIL — "Cannot find module './renderReport'".

- [ ] **Step 3: Viết `renderReport.ts`**

```ts
import type { CrawlSnapshot, AnalysisResult } from "./types";
import type { MetricRow } from "./db";

const SEV_ICON: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

function delta(today: number, prev: number | null | undefined): string {
  if (prev === null || prev === undefined) return "";
  const d = today - prev;
  const sign = d >= 0 ? "+" : "";
  const pct = prev !== 0 ? ` (${sign}${Math.round((d / prev) * 100)}%)` : "";
  return ` \`${sign}${Math.round(d * 100) / 100}${pct}\``;
}

export function renderMarkdown(
  snap: CrawlSnapshot,
  a: AnalysisResult,
  yesterday: MetricRow[]
): string {
  const prevOf = (route: string, key: string) =>
    yesterday.find((m) => m.route === route && m.key === key)?.valueNum;

  const lines: string[] = [];
  lines.push(`# TikTok Shop — Báo cáo ${snap.runDate}`);
  lines.push("");
  lines.push(`> Trạng thái crawl: **${snap.status}** · ${snap.startedAt} → ${snap.finishedAt}`);
  lines.push("");
  lines.push(`## Tóm tắt`);
  lines.push(a.summary);
  lines.push("");

  lines.push(`## Chỉ số`);
  lines.push(`| Route | Chỉ số | Giá trị | Δ hôm qua |`);
  lines.push(`|---|---|---|---|`);
  for (const r of snap.routes) {
    for (const m of r.metrics) {
      const val = m.valueNum ?? m.valueText ?? "";
      const unit = m.unit && m.unit !== "count" ? ` ${m.unit}` : "";
      const d = m.valueNum != null ? delta(m.valueNum, prevOf(r.route, m.key)) : "";
      lines.push(`| ${r.route} | ${m.key} | ${val}${unit} |${d} |`);
    }
  }
  lines.push("");

  if (a.alerts.length) {
    lines.push(`## ⚠️ Cảnh báo`);
    for (const al of a.alerts) {
      lines.push(`- ${SEV_ICON[al.severity] ?? "•"} **${al.title}**${al.detail ? ` — ${al.detail}` : ""}${al.action ? ` → _${al.action}_` : ""}`);
    }
    lines.push("");
  }

  if (a.strengths.length) {
    lines.push(`## ✅ Điểm mạnh`);
    a.strengths.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (a.weaknesses.length) {
    lines.push(`## ❌ Điểm yếu`);
    a.weaknesses.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (a.todos.length) {
    lines.push(`## 📋 Việc cần làm`);
    [...a.todos].sort((x, y) => x.priority - y.priority).forEach((t) =>
      lines.push(`${t.priority}. **${t.task}**${t.why ? ` — ${t.why}` : ""}`)
    );
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `npx vitest run src/services/tiktok/renderReport.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/tiktok/renderReport.ts src/services/tiktok/renderReport.test.ts
git commit -m "feat(tiktok): markdown report renderer"
```

---

## Task 8: Orchestrator

> Orchestrator cần browser thật nên không unit-test toàn bộ. Tách logic thuần (`isLoginWall`) ra test riêng; phần lifecycle test thủ công ở Task 12.

**Files:**
- Create: `src/core/crawlTiktokSeller.ts`
- Test: `src/core/crawlTiktokSeller.test.ts`

- [ ] **Step 1: Viết test thất bại cho `isLoginWall`**

`src/core/crawlTiktokSeller.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isLoginWall } from "./crawlTiktokSeller";

describe("isLoginWall", () => {
  it("phát hiện redirect về trang login", () => {
    expect(isLoginWall("https://seller-us.tiktok.com/account/login?redirect=/homepage")).toBe(true);
    expect(isLoginWall("https://seller-us.tiktok.com/login")).toBe(true);
  });
  it("trang bình thường không phải login wall", () => {
    expect(isLoginWall("https://seller-us.tiktok.com/homepage")).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `npx vitest run src/core/crawlTiktokSeller.test.ts`
Expected: FAIL — "Cannot find module './crawlTiktokSeller'".

- [ ] **Step 3: Viết `crawlTiktokSeller.ts`**

```ts
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { ensureNoCaptcha } from "../services/kiki/captcha";
import { attachCaptureBus } from "../services/tiktok/captureBus";
import { ROUTES } from "../services/tiktok/routes";
import { TiktokDb } from "../services/tiktok/db";
import type { CrawlSnapshot, RouteMetrics, CrawlStatus } from "../services/tiktok/types";

export function isLoginWall(url: string): boolean {
  return /\/(account\/)?login|\/passport|\/signin/i.test(url);
}

export interface CrawlTiktokParams {
  profileId: string;
  db: TiktokDb;
  /** Bật discovery dump (data/_tiktok_discovery/<date>/). */
  discoverDir?: string;
  onLog?: (msg: string) => void;
}

/** Ngày địa phương dạng YYYY-MM-DD. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function humanScroll(page: any): Promise<void> {
  const step = 600 + Math.floor(Math.random() * 500);
  await page.mouse.wheel(0, step).catch(() => {});
  await page.waitForTimeout(700 + Math.floor(Math.random() * 900));
}

export async function crawlTiktokSeller(params: CrawlTiktokParams): Promise<CrawlSnapshot> {
  const { profileId, db, discoverDir } = params;
  const log = (m: string) => params.onLog?.(m);
  const runDate = todayStr();
  const startedAt = new Date().toISOString();
  const runId = db.startRun(runDate);

  log(`Force-stop profile ${profileId}…`);
  await kiki.forceStop(profileId);
  log(`Khởi động Kiki profile…`);
  const started = await kiki.startWithRetry(profileId, log);
  log(`Kết nối CDP (port ${started.debuggingPort})…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const routes: RouteMetrics[] = [];
  let status: CrawlStatus = "ok";
  let page: any;

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    const bus = attachCaptureBus(page, discoverDir ? { dumpDir: discoverDir } : {});

    for (const route of ROUTES) {
      bus.setRoute(route.key);
      bus.clear();
      const rm: RouteMetrics = { route: route.key, ok: false, metrics: [] };
      try {
        log(`→ ${route.key}: ${route.url}`);
        await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);

        if (isLoginWall(page.url())) {
          status = "login_required";
          rm.error = "login_required";
          routes.push(rm);
          log(`✗ Bị đẩy về trang login — cần đăng nhập lại trong cửa sổ Kiki.`);
          break;
        }

        await ensureNoCaptcha(page, { onLog: log, context: `TikTok ${route.key}`, profileId });
        if (route.waitForSelector) {
          await page.waitForSelector(route.waitForSelector, { timeout: 15_000 }).catch(() => {});
        }
        await humanScroll(page);
        await page.waitForTimeout(route.settleMs ?? 3000);

        const caps = bus.snapshot();
        for (const c of caps) db.insertRawCapture(runId, route.key, c.url, c.status);
        rm.metrics = route.extractor(caps);
        rm.ok = true;
        db.insertMetrics(runId, route.key, rm.metrics);
        log(`  ✓ ${rm.metrics.length} chỉ số (${caps.length} capture).`);
      } catch (e: any) {
        rm.error = e?.message ?? String(e);
        status = status === "ok" ? "partial" : status;
        log(`  ✗ Lỗi route ${route.key}: ${rm.error}`);
      }
      routes.push(rm);
    }
  } catch (e: any) {
    status = "error";
    log(`✗ Lỗi crawl: ${e?.message ?? e}`);
  } finally {
    try { if (page) await page.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile.`);
  }

  const finishedAt = new Date().toISOString();
  db.finishRun(runId, status);
  return { runId, runDate, startedAt, finishedAt, status, routes };
}
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `npx vitest run src/core/crawlTiktokSeller.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck toàn bộ**

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 6: Commit**

```bash
git add src/core/crawlTiktokSeller.ts src/core/crawlTiktokSeller.test.ts
git commit -m "feat(tiktok): crawl orchestrator (1 session, per-route)"
```

---

## Task 9: Config + appConfig getter

**Files:**
- Create: `config/tiktok.json`
- Modify: `src/config/appConfig.ts`

- [ ] **Step 1: Tạo `config/tiktok.json`**

```json
{
  "_comment": "profileId: id profile Kiki đã login TikTok Shop US. cron: lịch chạy. model: model Claude.",
  "enabled": false,
  "profileId": "",
  "cron": "0 8 * * *",
  "timezone": "Asia/Ho_Chi_Minh",
  "model": "claude-opus-4-8",
  "analyze": true
}
```

- [ ] **Step 2: Thêm interface + getter vào `src/config/appConfig.ts`**

Sau block `ResearchFile` interface (khoảng dòng 94), thêm:
```ts
export interface TiktokFile {
  enabled: boolean;
  profileId: string;
  cron: string;
  timezone?: string;
  model: string;
  analyze: boolean;
}
```

Cạnh các biến cache (`let _research...`), thêm:
```ts
let _tiktok: TiktokFile | null = null;
```

Cạnh các getter (sau `researchConfig`), thêm:
```ts
export const tiktokConfig = (): TiktokFile =>
  (_tiktok ??= readJson<TiktokFile>("tiktok.json"));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 4: Commit**

```bash
git add config/tiktok.json src/config/appConfig.ts
git commit -m "feat(tiktok): config file + appConfig getter"
```

---

## Task 10: Cron job + wiring

**Files:**
- Create: `src/core/tiktokCron.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Viết `src/core/tiktokCron.ts`**

```ts
/**
 * tiktokCron — cào TikTok seller + phân tích Claude 1 lần/ngày (config/tiktok.json).
 * Pattern theo researchCron: chống chạy chồng, validate lịch, gọi được thủ công.
 */
import cron, { type ScheduledTask } from "node-cron";
import fs from "fs-extra";
import path from "path";
import { tiktokConfig } from "../config/appConfig";
import { crawlTiktokSeller } from "./crawlTiktokSeller";
import { TiktokDb } from "../services/tiktok/db";
import { analyzeSnapshot } from "../services/tiktok/analyze";
import { renderMarkdown } from "../services/tiktok/renderReport";

let running = false;
let task: ScheduledTask | null = null;

function yesterdayStr(runDate: string): string {
  const d = new Date(runDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface RunTiktokOptions {
  discover?: boolean;
  noAi?: boolean;
  onLog?: (m: string) => void;
}

/** Chạy 1 lượt crawl + phân tích. Dùng cho cả cron lẫn gọi thủ công. */
export async function runTiktokJob(opts: RunTiktokOptions = {}): Promise<void> {
  if (running) {
    console.log("[tiktok-cron] Vòng trước chưa xong — bỏ lượt này.");
    return;
  }
  running = true;
  const log = opts.onLog ?? ((m: string) => console.log("[tiktok]", m));
  const db = new TiktokDb();
  try {
    const cfg = tiktokConfig();
    if (!cfg.profileId) throw new Error("Chưa cấu hình profileId trong config/tiktok.json");

    const discoverDir = opts.discover
      ? path.resolve(process.cwd(), "data", "_tiktok_discovery", new Date().toISOString().slice(0, 10))
      : undefined;

    log("▶ Bắt đầu crawl TikTok seller…");
    const snap = await crawlTiktokSeller({ profileId: cfg.profileId, db, discoverDir, onLog: log });
    log(`Crawl xong: status=${snap.status}, ${snap.routes.length} route.`);

    if (opts.discover) {
      log(`Discovery dump tại: ${discoverDir}`);
      return;
    }
    if (opts.noAi || !cfg.analyze) {
      log("Bỏ bước phân tích AI (--no-ai / analyze=false).");
      return;
    }

    const yMetrics = db.getMetricsByDate(yesterdayStr(snap.runDate));
    log("Gọi Claude phân tích…");
    const analysis = await analyzeSnapshot(snap, yMetrics, { model: cfg.model });
    const md = renderMarkdown(snap, analysis, yMetrics);

    const reportDir = path.resolve(process.cwd(), "docs", "reports");
    await fs.ensureDir(reportDir);
    const reportPath = path.join(reportDir, `${snap.runDate}-tiktok.md`);
    await fs.writeFile(reportPath, md, "utf-8");
    db.insertReport(snap.runId, path.relative(process.cwd(), reportPath), cfg.model);
    if (analysis.alerts.length) db.insertAlerts(snap.runId, analysis.alerts);

    log(`✅ Báo cáo: ${reportPath} (${analysis.alerts.length} alert).`);
  } catch (e: any) {
    console.error("[tiktok-cron] ✗ Lỗi:", e?.message ?? e);
  } finally {
    db.close();
    running = false;
  }
}

/** Đăng ký cron theo tiktok.json. Gọi lúc bootstrap. */
export function scheduleTiktokCron(): void {
  const c = tiktokConfig();
  if (!c.enabled) {
    console.log("⏰ TikTok cron: TẮT (tiktok.json → enabled=false)");
    return;
  }
  if (!cron.validate(c.cron)) {
    console.error(`⏰ TikTok cron: lịch không hợp lệ "${c.cron}" — bỏ qua.`);
    return;
  }
  task?.stop();
  task = cron.schedule(c.cron, () => runTiktokJob(), c.timezone ? { timezone: c.timezone } : undefined);
  console.log(`⏰ TikTok cron: ${c.cron}${c.timezone ? ` (${c.timezone})` : ""}`);
}
```

- [ ] **Step 2: Wire vào `src/index.ts`**

Thêm import cạnh `scheduleResearchCron` (dòng 11):
```ts
import { scheduleTiktokCron } from "./core/tiktokCron";
```
Thêm sau `scheduleResearchCron();` (dòng 37):
```ts
scheduleTiktokCron();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 4: Commit**

```bash
git add src/core/tiktokCron.ts src/index.ts
git commit -m "feat(tiktok): daily cron job + wiring"
```

---

## Task 11: Manual run script

**Files:**
- Create: `src/scripts/crawlTiktok.ts`

- [ ] **Step 1: Viết `src/scripts/crawlTiktok.ts`**

```ts
/**
 * Chạy tay crawl TikTok seller.
 *   npm run crawl:tiktok                 → cào + phân tích + report
 *   npm run crawl:tiktok -- --discover   → chỉ cào + dump raw endpoint (map)
 *   npm run crawl:tiktok -- --no-ai      → cào + lưu, bỏ AI
 */
import "dotenv/config";
import { runTiktokJob } from "../core/tiktokCron";

async function main() {
  const args = process.argv.slice(2);
  const discover = args.includes("--discover");
  const noAi = args.includes("--no-ai");
  await runTiktokJob({ discover, noAi, onLog: (m) => console.log("[tiktok]", m) });
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 3: Chạy full test suite**

Run: `npm test`
Expected: tất cả test PASS.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/crawlTiktok.ts
git commit -m "feat(tiktok): manual crawl script (--discover/--no-ai)"
```

---

## Task 12: DISCOVERY CHECKPOINT (cần profile Kiki thật)

> **Đây là milestone rủi ro cao nhất** — xác định endpoint thật của TikTok seller center. KHÔNG bỏ qua. Cần: profile Kiki đã login TikTok Shop US + Kiki local API đang chạy.

- [ ] **Step 1: Điền profileId**

Sửa `config/tiktok.json` → `"profileId": "<id-profile-kiki-tiktok>"`.

- [ ] **Step 2: Đảm bảo `.env` có key**

Thêm vào `.env` (KHÔNG commit): `ANTHROPIC_API_KEY=sk-ant-...`

- [ ] **Step 3: Chạy discovery**

Run: `npm run crawl:tiktok -- --discover`
Expected: log mở từng route, "Discovery dump tại: data/_tiktok_discovery/<ngày>". Nếu hiện captcha → giải tay trong cửa sổ Kiki. Nếu "login_required" → đăng nhập lại profile rồi chạy lại.

- [ ] **Step 4: Khảo sát dump**

Mở `data/_tiktok_discovery/<ngày>/homepage/` và `.../compass-overview/`. Tìm các file JSON chứa: GMV, số đơn, visitors, conversion, alert/notification count. Ghi lại TÊN KEY thật + endpoint.

- [ ] **Step 5: Tinh chỉnh extractor theo key thật**

Cập nhật danh sách `candidates` trong `src/services/tiktok/extractors/homepage.ts` và `compassOverview.ts` cho khớp key thật tìm được. Nếu URL Compass khác → sửa `url` trong `src/services/tiktok/routes.ts`. Nếu cần selector chờ → set `waitForSelector`.

- [ ] **Step 6: Lưu 1 fixture thật làm regression test**

Copy 1 file JSON tiêu biểu vào test, thêm 1 `it(...)` mới trong `extractors.test.ts` khẳng định extractor bóc đúng số từ fixture thật đó. Chạy: `npx vitest run src/services/tiktok/extractors/extractors.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/tiktok/extractors/ src/services/tiktok/routes.ts
git commit -m "fix(tiktok): tune extractors to real endpoints (discovery)"
```

---

## Task 13: End-to-end thật + report

- [ ] **Step 1: Chạy full pipeline**

Run: `npm run crawl:tiktok`
Expected: crawl → lưu DB → gọi Claude → ghi `docs/reports/<ngày>-tiktok.md`. Log kết thúc "✅ Báo cáo: ...".

- [ ] **Step 2: Kiểm tra report**

Mở `docs/reports/<ngày>-tiktok.md` — phải có: tiêu đề ngày, summary, bảng chỉ số, alert (nếu có), todo. Kiểm tra số liệu khớp với seller center.

- [ ] **Step 3: Kiểm tra DB**

Run (PowerShell, nếu có sqlite3) hoặc viết script nhỏ: xác nhận bảng `crawl_runs` có 1 row status `ok`/`partial`, `metrics` có dữ liệu.

- [ ] **Step 4: Bật cron**

Sửa `config/tiktok.json` → `"enabled": true`. Khởi động lại worker (`npm start`) → log "⏰ TikTok cron: 0 8 * * * (Asia/Ho_Chi_Minh)".

- [ ] **Step 5: Commit cấu hình bật**

```bash
git add config/tiktok.json
git commit -m "chore(tiktok): enable daily cron"
```

---

## Verification Checklist (cuối cùng)

- [ ] `npm test` — toàn bộ unit test PASS.
- [ ] `npm run typecheck` — không lỗi.
- [ ] `npm run crawl:tiktok -- --discover` chạy được, dump ra file.
- [ ] Extractor đã map đúng key thật (Task 12).
- [ ] `npm run crawl:tiktok` sinh report Markdown đúng định dạng.
- [ ] Cron đăng ký khi `enabled=true`.
- [ ] `.env` có `ANTHROPIC_API_KEY`, KHÔNG bị commit.
- [ ] `data/tiktok.db` + `data/_tiktok_discovery/` bị gitignore.
