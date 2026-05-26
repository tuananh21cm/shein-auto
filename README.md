# shein-auto

Background worker tự động đăng listing Shein lên TikTok Shop qua [4Seller](https://www.4seller.com).
Có Admin UI dashboard realtime, history retry, Telegram notification, parallel worker.

## Luồng chạy

1. **File Router** (cron) — quét `DOWNLOAD_DIR`, nhận diện file `P5-XXX*.json`, move vào `BASE_SHEINAUTO_DIR/<shop>/`
2. **Queue Manager** (cron) — round-robin folder, pick file cũ nhất, spawn worker
3. **Worker** ([src/core/listing4sellerShein.ts](src/core/listing4sellerShein.ts)) — Playwright orchestrator gọi các step trong [src/core/steps/](src/core/steps/)
4. **State + Notify** — mỗi run cập nhật state vào [history.json](data/history.json), bắn Telegram notify, đẩy event qua SSE xuống Admin UI

## Cài đặt

```powershell
npm install
npx playwright install chromium
copy .env.example .env              # rồi điền GEMINI_API_KEY, TELEGRAM_*
```

## Chạy

```powershell
npm run dev        # tsx watch
npm start          # production
npm run typecheck  # tsc --noEmit
```

Admin UI: http://localhost:3000/admin (default: `admin` / `admin` — đổi ngay lần đầu).

## Cấu trúc

```
config/                              # JSON config, sửa không cần build
├── brand-profiles.json              # profile shop → brand
├── pricing.json                     # công thức giá (offset/divisor), dimension
├── worker.json                      # concurrency, cron, image waits
├── size-map.json                    # normalize size SHEIN → TikTok
└── tiktok-categories.json           # master list category

src/
├── index.ts                         # entry: cron + admin server bootstrap
├── config.ts                        # env vars
├── config/appConfig.ts              # loader cho config/*.json
├── adminServer.ts                   # Express + session + SSE
├── adminConfig.ts                   # user CRUD, bcrypt password
├── public/admin.html                # SPA-lite UI (Dashboard/History/Users/Settings/Cookie)
├── public/login.html
├── queue/
│   ├── fileRouter.ts                # scan Downloads → phân loại shop
│   └── queueManager.ts              # round-robin + parallel concurrency
├── core/
│   ├── listing4sellerShein.ts       # orchestrator (120 dòng)
│   └── steps/                       # 12 step file, mỗi file <200 dòng
├── services/
│   ├── gemini/                      # AI title + category mapping
│   └── notification/telegram.ts
├── state/                           # eventBus + WorkerState + QueueState + HistoryStore
└── utils/

data/                                # runtime state (không commit)
├── admin-config.json                # users (bcrypt password)
├── settings.json
└── history.json                     # log 500 entry gần nhất
```

## Admin UI features

| Trang | Mô tả |
|---|---|
| **Dashboard** | Stat card (worker/queue/last/telegram), bảng queue theo shop, jobs đang chạy, **live log SSE** |
| **History** | Filter status/folder, view JSON gốc, **retry 1-click** (move từ Fail về folder shop) |
| **Users** | CRUD user, role (admin/editor/viewer), bcrypt password tự động |
| **Settings** | Sửa concurrency, headless, cron, image waits — ghi vào `config/worker.json`, reload runtime |
| **Cookie** | Paste JSON cookie 4Seller, **test cookie** (mở Chromium headless thử login) |

## Telegram notification

Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` trong `.env`. Worker sẽ bắn:
- ✅ Listing thành công + thời gian
- ❌ Listing fail + error message (truncated 500 chars)

Để trống = tắt notify (worker vẫn chạy bình thường).

## Parallel worker

Set `config/worker.json` → `concurrency: N`. Worker pool sẽ pick N folder khác nhau mỗi tick.
Mỗi folder có lock riêng → không 2 file cùng shop chạy đồng thời.
Mỗi browser tốn ~500MB RAM, lưu ý nếu N > 3.

## Cấu trúc JSON file đầu vào

Tên file phải match `^P\d-\d{3}(_[A-Z]{2})?.*\.json$` (vd: `P5-034.json`, `P5-034_DE.json`).

| Field | Bắt buộc | Mô tả |
|---|---|---|
| `product_name` | ✅ | Title gốc → AI rewrite |
| `category` | ✅ | Path category gốc → AI map sang TikTok |
| `listing_variations.sizes` | ✅ | Mảng size, sẽ chuẩn hoá XS/S/M/L/XL |
| `listing_variations.colors` | ✅ | Mảng tên màu |
| `variant_images` | ✅ | `[{colorName: [urls]}]` |
| `variant_price` | ✅ | `[{colorName: number}]` |
| `variant_ids` | ✅ | SKU theo variant |
| `product_images` | ✅ | Mảng URL ảnh gốc |
| `attributes` | ✅ | Object attribute → sinh description |
| `sizes_available` | ✅ | Mảng size khả dụng |
| `brand_name` | — | Override theo profile (config/brand-profiles.json) |
| `size_chart` | — | `{data: [{...}]}` để render PNG |
| `size_chart_img` | — | base64 PNG sẵn có |

## Migrating từ version cũ

- Mọi data plaintext password trong `data/admin-config.json` sẽ được auto-hash sau login đầu tiên
- Brand mapping cũ ở `core/listing4sellerShein.ts` đã chuyển sang `config/brand-profiles.json`
- Công thức giá `(price+13)/0.623` đã externalize trong `config/pricing.json`
