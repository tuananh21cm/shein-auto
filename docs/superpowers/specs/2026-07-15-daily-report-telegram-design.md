# Daily Report qua Telegram — Design

Ngày: 2026-07-15 · Trạng thái: Approved

## Mục tiêu

Mỗi ngày **8:00 sáng (Asia/Ho_Chi_Minh)** gửi 1 report tổng hợp vào **kênh Telegram riêng** (channel mới, chỉ nhận report daily). Nội dung 8 mục:

1. Tổng listing mới so với hôm qua + tổng listing đang có, per shop
2. Số video đăng hôm qua so với hôm kia + tổng video, per shop
3. Số đơn hôm qua per shop (theo ngày US của 4Seller)
4. Danh sách shop đang hết flash sale
5. Danh sách shop có >10 sản phẩm chưa chạy discount (kèm số lượng)
6. Danh sách shop có sản phẩm Low Stock (≤20) / Hết hàng (=0), kèm số sp
7. Số đơn overdue per shop (v1: chỉ số lượng, từ crawl TikTok Seller)

## Cấu hình

- `DAILY_REPORT_TG_CHAT_ID` (bắt buộc — chưa set thì job tự tắt, log warning)
- `DAILY_REPORT_TG_BOT_TOKEN` (tùy chọn, fallback `TELEGRAM_BOT_TOKEN`)
- Cron: `0 8 * * *`, timezone `Asia/Ho_Chi_Minh`, đăng ký trong `bootstrap()` của `src/index.ts`

## Kiến trúc

Module mới `src/core/dailyReport.ts` theo pattern `tiktokCron.ts`:

- `runDailyReportOnce(onLog?)` — gather → snapshot → render → send. Guard `running` chống chạy chồng. Chạy tay được: `npx tsx src/scripts/runDailyReport.ts`
- `scheduleDailyReport()` — node-cron, gọi `runDailyReportOnce`

### Bảng snapshot mới (shein-auto.db)

```sql
CREATE TABLE IF NOT EXISTS daily_report_snapshot (
  day TEXT NOT NULL,        -- YYYY-MM-DD giờ VN
  shop TEXT NOT NULL,
  active_listings INTEGER,  -- từ 4Seller getStatusCount
  total_videos INTEGER,     -- từ videos.db status='posted'
  PRIMARY KEY (day, shop)
);
```

Job ghi snapshot hôm nay TRƯỚC khi render; diff = hôm nay − snapshot hôm qua (nếu có).

### Nguồn data per mục

| Mục | Nguồn | Ghi chú |
|---|---|---|
| Tổng listing/shop | trigger refresh promo scan (`runAndStorePromoScan`) → `activeListings` per shop | fallback đọc `_promo_scan.json` cũ nếu refresh lỗi |
| Listing mới hôm qua | bảng `history` (status='success', finished_at trong hôm qua VN, group by folder) + diff snapshot | history cap 500 rows — đủ cho 1 ngày |
| Video đăng hôm qua + tổng | `videos.db` — `posted_at` trong hôm qua VN; tổng `status='posted'` per shop | so với hôm kia bằng cùng query lùi 1 ngày (không cần snapshot) |
| Đơn hôm qua/shop | 4Seller `getSalesByShop(yesterdayUS)` | ngày US, ghi rõ trong report |
| Shop hết flash | promo scan rows: `flashOngoing===0` (kèm `flashExpired`) | |
| Shop >10 sp chưa discount | promo scan rows: `uncoveredProducts > 10` | |
| Low Stock / Hết hàng | `tiktok.db listing_views` — run_date mới nhất per shop; `stock<=20` / `stock==0` | chỉ shop đã crawl; shop chưa crawl ghi "chưa có data" |
| Đơn overdue/shop | `tiktok.db metrics` — key `action_shipping_overdue`, run mới nhất per shop | v1 số lượng; v2 build wrapper 4Seller order-list |

### Render & gửi

- Plain text tiếng Việt + emoji, KHÔNG markdown (theo pattern `renderTelegram` của tiktok notifyReport)
- Chunk ≤3900 ký tự bằng `chunkText` có sẵn (`src/services/tiktok/notifyReport.ts`)
- Mỗi mục gather trong try/catch độc lập — mục lỗi hiện `⚠️ <lý do>`, các mục khác vẫn gửi

## Error handling

- Thiếu chat id → skip + log, không throw
- 4Seller cookie chết → mục listing/đơn báo lỗi, mục video/stock vẫn chạy
- Telegram lỗi → log warning, không crash cron

## Testing

- Unit test render (input giả → text đúng section, đúng diff)
- Test thật: chạy `runDailyReport.ts` gửi vào channel thật
