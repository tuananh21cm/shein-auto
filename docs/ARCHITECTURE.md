# Shein-Auto: Architecture & Flow

## Tổng quan

**Shein-Auto** là background worker tự động đăng sản phẩm từ SHEIN lên TikTok Shop thông qua nền tảng [4Seller](https://www.4seller.com). Hệ thống gồm 3 phần chính:

1. **Tampermonkey Script** — cào dữ liệu sản phẩm từ SHEIN
2. **Backend Worker** — tự động điền form và publish lên 4Seller bằng Playwright
3. **Admin UI** — giao diện web quản lý, theo dõi, cấu hình

---

## Kiến trúc tổng thể

```
┌──────────────────────┐          ┌──────────────────────────────────────────┐
│   Tampermonkey v27    │  POST    │              Backend (Node.js)           │
│  (chạy trên browser  │ ───────► │                                          │
│   khi vào shein.com)  │ /ingest  │  ┌──────────┐  ┌───────────┐            │
│                       │          │  │  Admin    │  │  Express  │◄── Browser │
│  - Cào product data   │          │  │  Server   │  │  (port    │   Admin UI │
│  - Detect stock per   │          │  │           │  │   3000)   │            │
│    (color × size)     │          │  └──────────┘  └───────────┘            │
│  - POST JSON lên      │          │                                          │
│    worker server      │          │  ┌──────────┐  ┌───────────┐            │
└──────────────────────┘          │  │  File     │  │  Queue    │            │
                                   │  │  Router   │  │  Manager  │            │
                                   │  │ (30s cron)│  │ (1m cron) │            │
                                   │  └─────┬─────┘  └─────┬─────┘            │
                                   │        │               │                  │
                                   │        ▼               ▼                  │
                                   │   Move file      Pick oldest file         │
                                   │   vào shop/      → spawn Worker           │
                                   │                                          │
                                   │  ┌────────────────────────────────────┐   │
                                   │  │         Worker (Playwright)        │   │
                                   │  │  Mở Chromium → 4Seller → Điền form │   │
                                   │  │  → Upload ảnh → Publish            │   │
                                   │  └────────────────────────────────────┘   │
                                   │                                          │
                                   │  ┌──────────┐  ┌───────────┐            │
                                   │  │ SQLite   │  │  Gemini   │            │
                                   │  │ (data/)  │  │  AI API   │            │
                                   │  └──────────┘  └───────────┘            │
                                   └──────────────────────────────────────────┘
```

---

## Luồng dữ liệu chi tiết

### Phase 1: Thu thập dữ liệu (Tampermonkey)

```
User duyệt SHEIN ──► Tampermonkey cào product page
                      ├── product_name, category, attributes
                      ├── variant_images (per color)
                      ├── variant_price (per color)
                      ├── listing_variations (sizes, colors)
                      ├── available_matrix (color × size stock)
                      ├── size_chart, product_images
                      └── POST /admin/api/ingest ──► Server lưu JSON
                                                     vào downloadDir/
```

- Script sync danh sách shop (profiles) từ server, user chọn shop đích
- File JSON đặt tên dạng `P5-034.json`, `P5-034_DE.json`
- Auth bằng API token (Bearer) — mỗi user được generate token riêng

### Phase 2: File Router (cron mỗi 30s)

```
downloadDir/               baseSheinAutoDir/
├── P5-022_xxx.json  ──►   ├── P5-022/
├── P5-034_yyy.json  ──►   │   └── P5-022_xxx.json    (pending)
└── P5-034_DE_zzz.json ──► ├── P5-034/
                            │   └── P5-034_yyy.json    (pending)
                            └── P5-034_DE/
                                └── P5-034_DE_zzz.json (pending)
```

- Quét `downloadDir` của từng user (multi-user support)
- Nhận diện prefix shop từ tên file (regex: `^P\d-\d{3}(_[A-Z]{2})?`)
- Move vào `baseSheinAutoDir/<shop>/`
- Tôn trọng per-user `autoCron` setting

### Phase 3: Queue Manager (cron mỗi 1 phút)

```
baseSheinAutoDir/
├── P5-022/
│   ├── oldest.json  ◄── Pick file cũ nhất
│   ├── second.json
│   └── ...
├── P5-034/
│   └── ...
└── .last_folder.txt  ◄── Track round-robin position
```

- **Round-robin** giữa các shop folder (không thiên vị shop nào)
- **Concurrency control**: chạy tối đa N browser song song (config `worker.json`)
- **Folder lock**: mỗi folder chỉ 1 worker tại 1 thời điểm
- **Multi-user**: iterate qua tất cả user, mỗi user có dirs/settings riêng
- Pick file JSON cũ nhất → gọi `processFile()` → spawn Worker

### Phase 4: Worker (`listing4sellerShein`)

Đây là orchestrator chính, chạy Playwright trên Chromium:

```
┌─ Step 1: Khởi tạo
│  ├── Load cookie 4Seller (per user)
│  ├── Launch Chromium (headless hoặc visible)
│  ├── Đọc & parse file JSON
│  └── KICK OFF Gemini calls (song song với page load):
│       ├── genTitleFromShein() — AI rewrite title
│       └── findCategory() — AI map category SHEIN → TikTok
│
├─ Step 2: Setup trên 4Seller
│  ├── Goto 4Seller create listing page
│  ├── Detect cookie expired (redirect → login = fail)
│  └── Select shop profile từ dropdown
│
├─ Step 3: Điền thông tin sản phẩm
│  ├── Fill title (AI-generated, cleaned)
│  ├── Select category (AI-mapped to TikTok taxonomy)
│  ├── Enable "Has Variations"
│  ├── preprocessData() — normalize sizes, dedup, filter
│  ├── fillVariations() — điền bảng color × size
│  ├── fillTableData() — giá, SKU, số lượng, cân nặng
│  ├── removeUnavailableVariants() — xoá (color,size) hết hàng
│  ├── uploadProductImages() — upload ảnh sản phẩm chính
│  ├── uploadVariantImages() — upload ảnh per variant
│  ├── handleBrand() — điền brand name
│  ├── fillDescription() — HTML description từ attributes
│  ├── uploadDescriptionImages() — ảnh trong mô tả
│  ├── fillShippingAndCertification() — thông tin vận chuyển
│  └── handleSizeChartUpload() — upload bảng size
│
├─ Step 4: Publish
│  ├── Click "Save & Publish" (hoặc dryRun = chỉ draft)
│  └── detectPublishOutcome() — đọc kết quả publish
│
└─ Step 5: Kết quả
   ├── OK  → Move JSON vào shop/Success/
   └── FAIL → Move JSON vào shop/Fail/
              + Ghi .error.log
              + Screenshot debug
              + Gửi Telegram notification
```

#### Cơ chế fail-fast

Sau mỗi major step, `assertNoErrors()` kiểm tra 4Seller có hiển thị error toast không. Nếu có → throw ngay, không chạy tiếp các bước sau.

### Phase 5: Post-processing

```
shop/
├── pending.json        ← file đang chờ
├── Success/
│   └── done.json       ← listing thành công
└── Fail/
    ├── failed.json     ← listing thất bại
    └── failed.json.error.log  ← chi tiết lỗi + screenshot path
```

- **History**: lưu vào SQLite (`history` table), giữ tối đa 500 entries
- **Telegram**: chỉ gửi notification khi **fail** (không gửi khi success)
- **EventBus**: phát event `history`, `queue`, `log` cho SSE stream → Admin UI realtime

---

## Hệ thống AI (Gemini)

### Title Generation
```
product_name gốc từ SHEIN
    ↓ genTitleFromShein()
    ↓ Gemini API rewrite
    ↓ cleanTitle() — parse, thêm brand
    ↓ Final title cho TikTok
```

### Category Mapping
```
category path từ SHEIN (vd: "Women > Dresses > Maxi Dresses")
    ↓ findCategory()
    ↓ Gemini API map sang TikTok taxonomy
    ↓ Category path cho 4Seller dropdown
```

### Caching
- **Gemini Cache** trong SQLite (`gemini_cache` table)
- Key: SHA-256 hash của input (normalized lowercase)
- Title và category cache riêng biệt
- Cache hit = instant, không gọi API
- Retry logic: retry 503/429 với exponential backoff

---

## Multi-User & Permissions

### User Model (SQLite)

| Field | Mô tả |
|---|---|
| `username` | Login name, primary key |
| `password` | bcrypt hash |
| `role` | `admin` / `editor` / `viewer` |
| `profiles` | Danh sách shop folders được phép (rỗng = tất cả) |
| `downloadDir` | Thư mục download riêng (fallback env) |
| `baseSheinAutoDir` | Thư mục gốc chứa shops (fallback env) |
| `apiToken` | Token cho Tampermonkey (`tm_...`) |

### Per-User Overrides

Mỗi user có thể override settings global:

| Override | Inherit từ |
|---|---|
| `autoCronOverride` | `worker.json → autoCron` |
| `headlessOverride` | `worker.json → headless` |
| `shipFeeOverride` | `pricing.json → shipFee` |
| `multiplierOverride` | `pricing.json → multiplier` |
| `extraAddOverride` | `pricing.json → extraAdd` |
| `brandProfilesOverride` | `brand-profiles.json` |

### Shop Ownership

- User khai báo `profiles: ["P5-022", "P5-034"]` → chỉ xử lý 2 shop đó
- User có `profiles: []` (catch-all) → xử lý tất cả shop chưa bị user khác claim
- Conflict detection: không cho 2 user cùng downloadDir hoặc cùng baseSheinAutoDir

---

## Pricing

```
finalPrice = (originalPrice + shipFee) × multiplier + extraAdd
```

- Mặc định: `shipFee=5`, `multiplier=1.6`, `extraAdd=0`
- Ví dụ: giá gốc $10 → ($10 + $5) × 1.6 + $0 = $24
- Per-user override cho phép mỗi user có chiến lược giá khác

---

## Admin UI & API

### Web Interface (Express, port 3000)

- **Login**: session-based auth (8h expiry)
- **Dashboard**: realtime log stream (SSE), worker state, queue snapshot
- **Listings**: browse pending/success/fail per shop, xem chi tiết, retry, delete
- **History**: bảng lịch sử với filter status/folder, pagination
- **Users**: CRUD user, cấu hình dirs, profiles, overrides
- **Settings**: global worker config, pricing, brand profiles

### Key API Endpoints

| Endpoint | Mô tả |
|---|---|
| `POST /admin/api/auth/login` | Đăng nhập |
| `GET /admin/api/auth/me` | User hiện tại |
| `GET /admin/api/status` | Worker state + queue snapshot |
| `GET /admin/api/history` | Lịch sử listing |
| `GET /admin/api/listings/shops` | Tổng hợp per shop |
| `GET /admin/api/listings` | Browse listings |
| `POST /admin/api/listings/:id/retry` | Retry 1 listing fail |
| `POST /admin/api/listings/:id/run-now` | Chạy ngay 1 listing pending |
| `DELETE /admin/api/listings/:id` | Xoá listing |
| `POST /admin/api/ingest` | Nhận JSON từ Tampermonkey |
| `GET /admin/api/sse` | Server-Sent Events stream |
| `POST /admin/api/config` | Lưu user/settings config |
| `POST /admin/api/cookie/upload` | Upload cookie 4Seller |
| `POST /admin/api/fourseller/*` | Proxy 4Seller API |

### SSE Events

Admin UI subscribe `/admin/api/sse` để nhận realtime:
- `log` — console output từ worker
- `worker:state` — job đang chạy, last folder
- `history` — entry mới (success/fail)
- `queue` — queue snapshot cập nhật

---

## Cấu trúc thư mục

```
shein-auto/
├── src/
│   ├── index.ts                      # Entry point, bootstrap, cron setup
│   ├── config.ts                     # Env vars (.env)
│   ├── adminConfig.ts                # User CRUD (SQLite)
│   ├── adminServer.ts                # Express server + API routes
│   │
│   ├── config/
│   │   └── appConfig.ts              # Read config JSONs, pricing formula
│   │
│   ├── core/
│   │   ├── listing4sellerShein.ts    # Orchestrator chính
│   │   └── steps/
│   │       ├── preprocessData.ts     # Normalize sizes, dedup, filter
│   │       ├── selectProfile.ts      # Select shop trên 4Seller dropdown
│   │       ├── findCategory.ts       # AI category mapping
│   │       ├── fillVariations.ts     # Điền bảng variations
│   │       ├── fillTableData.ts      # Giá, SKU, qty, weight
│   │       ├── removeUnavailableVariants.ts  # Xoá variants hết hàng
│   │       ├── uploadImages.ts       # Upload product + variant images
│   │       ├── handleBrand.ts        # Điền brand name
│   │       ├── fillDescription.ts    # HTML description + images
│   │       ├── fillShipping.ts       # Shipping info
│   │       ├── handleSizeChart.ts    # Size chart upload
│   │       ├── publishAndDetect.ts   # Click publish + detect outcome
│   │       ├── randomUtils.ts        # Profile name extraction
│   │       └── cleanupTemp.ts        # Dọn temp files
│   │
│   ├── queue/
│   │   ├── fileRouter.ts             # Cron: quét downloads → phân loại
│   │   └── queueManager.ts           # Cron: round-robin pick → spawn worker
│   │
│   ├── services/
│   │   ├── gemini/
│   │   │   ├── genTitleFromShein.ts   # Gemini: rewrite title
│   │   │   ├── mapCategoryToTikTok.ts # Gemini: map category
│   │   │   └── geminiCache.ts         # SQLite cache cho Gemini results
│   │   ├── notification/
│   │   │   └── telegram.ts            # Telegram bot notification (fail only)
│   │   └── fourseller/
│   │       └── client.ts              # HTTP client cho 4Seller API
│   │
│   ├── state/
│   │   ├── db.ts                      # SQLite init, migrations, legacy import
│   │   ├── userDirs.ts                # Multi-user dir resolution, overrides
│   │   ├── workerState.ts             # In-memory worker job state
│   │   ├── queueState.ts              # Queue snapshot (pending counts)
│   │   ├── historyStore.ts            # History CRUD (SQLite)
│   │   ├── listingScan.ts             # Scan filesystem → listing cards
│   │   └── eventBus.ts                # EventEmitter + console tap → SSE
│   │
│   ├── utils/
│   │   ├── configCookie.ts            # Load cookie 4Seller (per user)
│   │   ├── retryGemini.ts             # Retry 503/429 cho Gemini
│   │   └── cleanTitle.ts              # Parse AI title output
│   │
│   ├── public/
│   │   ├── admin.html                 # Admin dashboard SPA
│   │   └── login.html                 # Login page
│   │
│   └── scripts/                       # Dev/debug scripts
│       ├── runOne.ts                  # Chạy 1 file thủ công
│       ├── testTelegram.ts            # Test Telegram notification
│       ├── testCookie.ts              # Test cookie load
│       └── db*.ts                     # Database inspection tools
│
├── config/
│   ├── worker.json                    # Cron schedule, concurrency, headless
│   ├── pricing.json                   # Pricing formula
│   ├── brand-profiles.json            # Brand mapping per shop
│   ├── size-map.json                  # Size normalization map
│   └── tiktok-categories.json         # Danh sách TikTok categories
│
├── data/                              # Runtime data (gitignored)
│   ├── shein-auto.db                  # SQLite database
│   ├── cookies/                       # Per-user 4Seller cookies
│   └── screenshots/                   # Debug screenshots khi fail
│
├── tampermonkey/
│   └── sheincrawl-v27.user.js         # Browser userscript
│
└── .env                               # GEMINI_API_KEY, TELEGRAM_*, dirs
```

---

## Database (SQLite)

File: `data/shein-auto.db`, journal mode WAL.

### Tables

| Table | Mô tả |
|---|---|
| `users` | User accounts, settings, overrides |
| `history` | Listing results (success/fail), max 500 |
| `gemini_cache` | AI response cache (title/category) |
| `settings_kv` | Key-value settings store |

### Migrations

Schema versioned qua `PRAGMA user_version`. Hiện tại 4 migrations:
- v1: Schema ban đầu (users, history, gemini_cache, settings_kv)
- v2: Per-user autoCron + headless override
- v3: Per-user pricing override
- v4: Per-user brand mapping override

### Legacy Import

Khi init lần đầu, tự động import từ JSON files cũ (`admin-config.json`, `history.json`, `gemini.json`) rồi rename thành `.migrated`.

---

## Config & Environment

### .env

| Variable | Bắt buộc | Mô tả |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token cho notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID |
| `DOWNLOAD_DIR` | No | Default download dir (fallback cho user chưa set) |
| `BASE_SHEINAUTO_DIR` | No | Default base dir (fallback cho user chưa set) |
| `ADMIN_PORT` | No | Port cho Admin UI (default: 3000) |
| `ADMIN_SESSION_SECRET` | No | Express session secret |

### config/worker.json

| Key | Default | Mô tả |
|---|---|---|
| `autoCron` | `true` | Bật/tắt cron tự động |
| `concurrency` | `1` | Số browser chạy song song |
| `headless` | `false` | Chromium headless mode |
| `fileRouterCron` | `*/30 * * * * *` | Mỗi 30 giây |
| `queueManagerCron` | `*/1 * * * *` | Mỗi 1 phút |
| `imageUploadWaitPerImageMs` | `7000` | Chờ per image upload |
| `imageUploadMaxImages` | `9` | Max product images |
| `descriptionImagesCount` | `8` | Số ảnh trong description |
| `descriptionMaxAttributes` | `8` | Max attributes trong description |

---

## Error Handling & Recovery

1. **Cookie expired**: Detect redirect về login page → throw, file move vào Fail
2. **4Seller UI error toast**: `assertNoErrors()` fail-fast sau mỗi step
3. **Gemini API**: Retry 503/429 với backoff, cache để giảm API calls
4. **Browser crash**: try/finally đảm bảo browser luôn được close
5. **File race condition**: Check `pathExists` trước khi move (user có thể delete/retry từ UI)
6. **Debug**: headless=false giữ browser mở 30s khi lỗi để inspect manual
7. **Screenshots**: Chụp screenshot khi fatal error, lưu path trong error log
8. **Telegram**: Chỉ notify khi fail — không spam khi success

## Video Studio (2026-07)

Module gen video TikTok từ ảnh sản phẩm 4Seller — spec: `docs/superpowers/specs/2026-07-13-video-studio-design.md`.

**Luồng:** `listing_views` (tín hiệu view/sold) → đề xuất SP tiềm năng (`suggestProducts`, tái dùng getFlashCandidates) → kéo ảnh 4Seller (`fetchImages`: getListingDetail + sharp 1080x1920 + remakeImage chống trùng) → Gemini gen script theo 1 trong 6 kịch bản hook A/B (`genVideoScript` + HOOK_STYLES; social_proof bơm số THẬT pv/orders 28d) → Edge TTS free (`services/tts/edgeTts`, word timestamps) → caption `.ass` sync (`buildAss`) → FFmpeg zoompan/xfade render 9:16 (`renderPlan` + `renderVideo`, ~20-30s/video) → quản lý tại `/admin/videos` (đề xuất, preview, download, đánh dấu đã đăng, retry). KHÔNG auto-post.

**Vị trí code:** `src/core/videoStudio/` (queue, render, routes) · `src/services/tts/` · `src/state/videoDb.ts` (SQLite `data/videos.db`, status: queued→generating→ready|error, ready→posted).

**Data:** video ra `data/videos/<shop>/<productId>_<id>.mp4`; ảnh cache `data/videos/assets/<productId>/`; nhạc nền user tự bỏ vào `data/videos/music/*.mp3` (rỗng = chỉ voice). Smoke test: `npx tsx src/scripts/testVideoRender.ts --variant=all`.
