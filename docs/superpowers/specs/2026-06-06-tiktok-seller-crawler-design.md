# TikTok Shop US — Seller Crawler & AI Analyzer (v1)

> Spec ngày 2026-06-06. Mục tiêu: cào dữ liệu seller center TikTok Shop US hằng ngày qua profile Kiki (anti-detect) đã đăng nhập, lưu snapshot, và dùng Claude phân tích alert/chỉ số → báo cáo Markdown hằng ngày kèm việc cần làm.

## 1. Bối cảnh & mục tiêu

Người dùng đã có 1 profile Kiki (anti-detect browser) đăng nhập sẵn TikTok Shop US Seller Center. Cần:

- Cào chỉ số/alert/thông tin từ seller center mỗi sáng (1 lần/ngày).
- Lưu snapshot theo ngày để so sánh ngày-qua-ngày.
- Dùng AI (Claude) phân tích: alert quan trọng, ưu/nhược điểm của shop, việc cần làm (ưu tiên).
- Xuất báo cáo Markdown theo ngày.

**Triết lý:** "cào lần lượt, full mọi ngóc ngách" — nhưng làm theo phase. v1 tập trung 2 khu giàu chỉ số nhất (Homepage + Compass) và chứng minh được cách bắt data ổn định, rồi mở rộng route ở các phase sau bằng cách thêm vào registry.

### Quyết định đã chốt (brainstorm)

| Hạng mục | Lựa chọn |
|---|---|
| Phạm vi v1 | Homepage + Compass (analytics) |
| Cách lấy data | Bắt API/BFF JSON nội bộ (passive intercept) |
| Lưu trữ | SQLite (`data/tiktok.db`) + báo cáo Markdown |
| AI phân tích | Claude API (`@anthropic-ai/sdk`) |
| Nhận báo cáo | File Markdown theo ngày (`docs/reports/YYYY-MM-DD-tiktok.md`) |
| Lịch | 1 lần/ngày buổi sáng, tái dùng cron sẵn có; chạy tay được |

## 2. Kiến trúc tổng thể

Tái dùng pattern Kiki hiện có (`src/services/kiki/client.ts` start profile → CDP websocket → Playwright `connectOverCDP` → gắn `response` interceptor bắt JSON nội bộ — y như `storeCrawler.ts` / `detailSignals.ts`).

```
cron (sáng) → crawlTiktokSeller (1 session Kiki duy nhất)
   └─ với mỗi route trong registry:
        goto → ensureNoCaptcha → warm-up (scroll kiểu người) → captureBus hứng JSON → extractor → RouteMetrics
   ↓
SQLite (snapshot theo ngày) + raw dump (route chưa map / discovery)
   ↓
analyze (Claude: snapshot hôm nay + diff hôm qua) → { summary, alerts, strengths, weaknesses, todos }
   ↓
docs/reports/YYYY-MM-DD-tiktok.md  +  bảng alerts trong DB
```

**Nguyên tắc:** 1 session Kiki dùng chung cho TẤT CẢ route (không restart profile mỗi route → ít cờ nghi ngờ). 1 route lỗi không giết cả lượt (try/catch từng route).

## 3. Module & ranh giới

Namespace mới `src/services/tiktok/` song song với `kiki/`.

### 3.1 `tiktok/captureBus.ts`
- **Làm gì:** `attach(page, opts)` gắn listener `page.on("response")`, gom mọi response JSON khớp host seller-us TikTok vào buffer `{ url, status, body }[]`.
- **Dùng sao:** orchestrator gọi `const bus = attach(page)` TRƯỚC khi `goto`, sau khi route xong gọi `bus.snapshot()` lấy captures và `bus.clear()` trước route kế. `bus.detach()` cuối cùng.
- **2 chế độ:**
  - *runtime*: chỉ giữ buffer trong RAM cho extractor đọc.
  - *discovery* (`opts.dumpDir`): ghi mỗi capture ra `data/_tiktok_discovery/<date>/<route>/<n>.json` (kèm url) để map endpoint thủ công.
- **Phụ thuộc:** `playwright-core` Page. Không phụ thuộc DB/AI.
- **Lọc:** chỉ giữ `content-type: json`, host chứa `tiktok` / `seller-us` / BFF nội bộ. Bỏ asset, tracking pixel.

### 3.2 `tiktok/routes.ts`
- **Làm gì:** registry khai báo các route cần đi:
  ```ts
  interface RouteDef {
    key: string;              // "homepage", "compass-overview"
    url: string;              // full URL seller-us.tiktok.com/...
    waitForSelector?: string; // chờ DOM ổn định (tùy chọn)
    settleMs?: number;        // chờ thêm cho BFF kịp về
    extractor: (caps: Capture[]) => RouteMetrics;
  }
  ```
- **v1:** `homepage`, `compass-overview`. Chừa chỗ thêm route phase sau = thêm 1 entry.
- **Phụ thuộc:** import extractor tương ứng.

### 3.3 `tiktok/extractors/*.ts`
- **Làm gì:** mỗi route 1 hàm thuần `(caps: Capture[]) => RouteMetrics`. Dùng `deepFind` (port từ `detailSignals.ts`) để bóc chỉ số bất kể endpoint đổi tên nhẹ.
- **Output chuẩn hoá:** `RouteMetrics = { route: string; metrics: Metric[] }` với `Metric = { key, valueNum?, valueText?, unit? }`.
- **Test:** đây là phần **unit-test được, KHÔNG cần browser** — chạy trên fixture JSON đã dump ở discovery.
- **v1 extractor:**
  - `homepage.ts`: alert/notification count, to-do list, tổng quan GMV/đơn (nếu homepage có), shop health snapshot nếu lộ.
  - `compassOverview.ts`: GMV, doanh thu, đơn, traffic (visitors/views), conversion rate, theo khoảng thời gian mặc định. (Chỉ số cụ thể chốt sau discovery.)

### 3.4 `core/crawlTiktokSeller.ts`
- **Làm gì:** orchestrator 1 lượt cào. Lifecycle theo `scrapeViaKiki.ts`:
  `forceStop → startWithRetry → connectOverCDP → newPage → loop routes → close → stopProfile`.
- **Mỗi route:** `bus.clear()` → `page.goto(url)` → `ensureNoCaptcha` → chờ `waitForSelector`/`settleMs` → warm-up scroll → `extractor(bus.snapshot())` → tích vào snapshot. Bọc try/catch: route lỗi ghi `notes`, tiếp tục.
- **Phát hiện login-wall:** nếu URL redirect về trang login → dừng cả lượt, ghi status `login_required`, báo (Telegram qua captcha util nếu tiện).
- **Trả về:** `CrawlSnapshot { runId, startedAt, finishedAt, status, routes: RouteMetrics[] }`.
- **Phụ thuộc:** `kiki/client`, `kiki/captcha`, `captureBus`, `routes`, `db`.

### 3.5 `tiktok/db.ts`
- **Làm gì:** wrapper `better-sqlite3` quanh `data/tiktok.db`. Khởi tạo schema (idempotent), API ghi run + metrics + raw_captures + report; API đọc snapshot theo ngày (cho diff).
- **Phụ thuộc:** `better-sqlite3` (đã có trong deps).

### 3.6 `services/anthropic/client.ts`
- **Làm gì:** wrapper mỏng quanh `@anthropic-ai/sdk`. Đọc `ANTHROPIC_API_KEY` từ `.env`. Hàm `complete({ system, user, schema? })` trả text/JSON. Bật **prompt caching** cho phần khung cố định (system + hướng dẫn).
- **Model mặc định:** `claude-opus-4-8` (có thể cấu hình qua env, hạ xuống sonnet cho rẻ nếu muốn).

### 3.7 `tiktok/analyze.ts`
- **Làm gì:** nạp snapshot hôm nay + hôm qua (từ db) → build prompt → gọi Claude → nhận JSON `{ summary, alerts[], strengths[], weaknesses[], todos[] }` → render Markdown → ghi `docs/reports/YYYY-MM-DD-tiktok.md` + lưu alerts/report vào db.
- **Phụ thuộc:** `db`, `anthropic/client`.

### 3.8 `scripts/crawlTiktok.ts`
- **Làm gì:** entrypoint chạy tay. Cờ:
  - (mặc định) cào → lưu → phân tích → ghi report.
  - `--discover`: chỉ cào + dump raw mọi endpoint (không cần extractor hoàn chỉnh) để map.
  - `--no-ai`: cào + lưu, bỏ bước phân tích.
- **npm script:** `"crawl:tiktok": "tsx src/scripts/crawlTiktok.ts"`.

## 4. Luồng dữ liệu & schema SQLite

File: `data/tiktok.db`. Long-format để thêm chỉ số mới không cần đổi schema.

```sql
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT NOT NULL,        -- 'YYYY-MM-DD'
  started_at  TEXT NOT NULL,        -- ISO
  finished_at TEXT,
  status      TEXT NOT NULL,        -- 'ok' | 'partial' | 'login_required' | 'error'
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES crawl_runs(id),
  route       TEXT NOT NULL,
  key         TEXT NOT NULL,        -- 'gmv', 'orders', 'conversion_rate', 'alert_count'...
  value_num   REAL,
  value_text  TEXT,
  unit        TEXT,                 -- 'USD', '%', 'count'...
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_key ON metrics(key);

CREATE TABLE IF NOT EXISTS raw_captures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES crawl_runs(id),
  route     TEXT NOT NULL,
  endpoint  TEXT NOT NULL,          -- url
  status    INTEGER,
  path      TEXT                    -- file body trên đĩa (discovery)
);

CREATE TABLE IF NOT EXISTS alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES crawl_runs(id),
  severity  TEXT NOT NULL,          -- 'high' | 'medium' | 'low'
  title     TEXT NOT NULL,
  detail    TEXT,
  action    TEXT                    -- việc cần làm
);

CREATE TABLE IF NOT EXISTS reports (
  run_id     INTEGER PRIMARY KEY REFERENCES crawl_runs(id),
  path       TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL
);
```

## 5. Phân tích AI (Claude)

- **Input:** snapshot hôm nay (metrics theo route) + snapshot hôm qua (nếu có) để tính delta.
- **Prompt:** system cố định mô tả vai trò "chuyên gia vận hành TikTok Shop"; user = JSON metrics + delta. Yêu cầu trả JSON đúng schema:
  ```json
  {
    "summary": "string",
    "alerts": [{ "severity": "high|medium|low", "title": "", "detail": "", "action": "" }],
    "strengths": ["string"],
    "weaknesses": ["string"],
    "todos": [{ "priority": 1, "task": "", "why": "" }]
  }
  ```
- **Prompt caching:** cache phần system + hướng dẫn schema (ổn định giữa các ngày).
- **Render:** Markdown gồm: tiêu đề + ngày, tóm tắt, bảng chỉ số (kèm Δ so hôm qua), danh sách alert (có icon mức độ), ưu/nhược, danh sách to-do ưu tiên.
- **Lỗi AI:** nếu Claude lỗi/parse fail → vẫn ghi report Markdown "raw metrics only" + log; không chặn crawl.

## 6. Chống bot / xử lỗi

- Tái dùng `kiki/captcha.ts` `ensureNoCaptcha` (notify Telegram + chờ giải tay trong cửa sổ Kiki).
- Login-wall: phát hiện redirect về login → status `login_required`, dừng lượt, báo.
- Delay/scroll ngẫu nhiên kiểu người (`humanScroll` port từ `storeCrawler.ts`) giữa & trong route.
- 1 session dùng chung mọi route. `forceStop` trước, `stopProfile` trong `finally`.
- Per-route try/catch → status `partial` nếu có route fail.

## 7. Lịch chạy & cấu hình

- Thêm vào `config/worker.json`:
  ```json
  "tiktok": {
    "enabled": false,
    "profileId": "<kiki-profile-id>",
    "cron": "0 8 * * *",
    "model": "claude-opus-4-8",
    "analyze": true
  }
  ```
- Đăng ký cron cạnh `fileRouterCron`/`queueManagerCron` hiện có (chỉ khi `tiktok.enabled`).
- `.env`: thêm `ANTHROPIC_API_KEY`.
- Chạy tay: `npm run crawl:tiktok` (và `-- --discover` cho phase map endpoint).

## 8. Kế hoạch theo phase

1. **Milestone 1 — Discovery (rủi ro cao nhất, làm trước):** `captureBus` + `scripts/crawlTiktok.ts --discover` → dump toàn bộ endpoint Homepage + Compass ra `data/_tiktok_discovery/`. Mục tiêu: xác định endpoint nào chứa chỉ số nào.
2. **Milestone 2 — Extractor + DB:** viết `homepage.ts` / `compassOverview.ts` extractor dựa trên fixture đã dump; `db.ts` schema + ghi snapshot. Unit test extractor trên fixture.
3. **Milestone 3 — Orchestrator e2e:** `crawlTiktokSeller.ts` chạy thật 1 lượt → lưu DB (chạy tay, không AI).
4. **Milestone 4 — AI + report:** `anthropic/client.ts` + `analyze.ts` → Markdown report + alerts.
5. **Milestone 5 — Cron:** wiring lịch + config, bật `enabled`.

## 9. Kiểm thử

- **Unit (không browser):** extractor trên fixture JSON; logic lọc `captureBus`; `db.ts` với SQLite in-memory; renderer Markdown.
- **E2E (thủ công, cần profile Kiki):** chạy `npm run crawl:tiktok` quan sát log + DB + report.
- **Discovery là điều kiện tiên quyết:** không viết extractor cứng trước khi có dump endpoint thật.

## 10. Ngoài phạm vi v1 (YAGNI)

- Các route khác (Orders, Products, Finance, Ads, Reviews, Health) — thêm ở phase sau qua registry.
- Dashboard/biểu đồ trend dài hạn (DB long-format đã sẵn sàng cho việc này về sau).
- Telegram/email báo cáo (mới chỉ file Markdown ở v1).
- Gọi thẳng API nội bộ TikTok (giòn, rủi ro ban).
- Nhiều lần/ngày.

## 11. Rủi ro & giả định

- **Giả định:** seller center lộ chỉ số qua JSON BFF (như đa số SPA TikTok). Nếu vài chỉ số chỉ nằm trong canvas/chart → fallback DOM cho riêng chỉ số đó (xử lý ở phase sau nếu gặp).
- **Rủi ro:** TikTok đổi tên endpoint/anti-bot mạnh hơn → extractor dùng `deepFind` + discovery dump giúp re-map nhanh.
- **Rủi ro:** session hết hạn đăng nhập → login-wall detection báo sớm để đăng nhập lại tay.
