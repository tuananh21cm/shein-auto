# Hướng dẫn cài shein-auto sang máy mới (Windows)

Hướng dẫn cài **mới tinh** trên một máy **Windows** khác, lấy code bằng **git clone**.

> ⚠️ 2 bẫy hay gặp:
> 1. `playwright-core` **KHÔNG tự tải trình duyệt** → phải cài Chromium khớp version (bước 4).
> 2. `better-sqlite3` là native module (thường có prebuilt sẵn, hiếm khi cần build tools).

---

## 1. Cài sẵn trên máy mới
- **Node.js LTS 18 trở lên** (khuyến nghị Node 20 LTS) — tải tại https://nodejs.org (đã kèm npm).
- **Git** — https://git-scm.com.
- *(Dự phòng)* Nếu `npm install` báo lỗi build `better-sqlite3`: cài **Visual Studio Build Tools** với workload **"Desktop development with C++"**. Thường KHÔNG cần vì có bản prebuilt cho Windows x64.

## 2. Lấy code
```powershell
git clone <URL_REPO> shein-auto
cd shein-auto
```

## 3. Cài dependencies
```powershell
npm install
```
(Cài cả devDependencies — `tsx` nằm trong đó và bắt buộc để chạy.)

## 4. Cài trình duyệt cho Playwright  ⚠️ BẮT BUỘC
```powershell
npx playwright@1.55.1 install chromium
```
→ tải Chromium vào `%LOCALAPPDATA%\ms-playwright\chromium-1223` (đúng chỗ `playwright-core@1.55.1` tìm). Bỏ bước này thì worker sẽ lỗi khi mở trình duyệt.

## 5. Tạo file cấu hình `.env`
```powershell
copy .env.example .env
```
Mở `.env` và điền:
| Key | Ghi chú |
|-----|---------|
| `GEMINI_API_KEY` | **Bắt buộc** — lấy tại https://aistudio.google.com/apikey. Thiếu thì AI title/category fail. |
| `DOWNLOAD_DIR` | Thư mục Chrome lưu JSON cào về, vd `C:/Users/<User>/Downloads` (dùng dấu `/`). |
| `BASE_SHEINAUTO_DIR` | Thư mục trung tâm chứa các folder shop, vd `C:/Users/<User>/Downloads/SheinAuto`. |
| `ADMIN_PORT` | Mặc định `3000`. |
| `ADMIN_SESSION_SECRET` | Đặt một chuỗi ngẫu nhiên (bảo mật session). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Để trống nếu không dùng notification. |

> Có thể để trống `DOWNLOAD_DIR`/`BASE_SHEINAUTO_DIR` rồi cấu hình **per-user** trong Admin UI > Users.

Tạo sẵn 2 thư mục `DOWNLOAD_DIR` và `BASE_SHEINAUTO_DIR` nếu chưa có. Thư mục `data/` (DB SQLite, screenshots, cookies) sẽ **tự tạo** khi chạy.

## 6. Chạy
```powershell
npm start          # chạy thường (tsx src/index.ts)
# hoặc:
npm run dev        # tự reload khi sửa code
```
Khởi động xong → mở **http://localhost:3000/admin**.

## 7. Cấu hình lần đầu trong Admin UI
1. Đăng nhập mặc định **admin / admin** → **đổi mật khẩu ngay**.
2. Tab **Users**: đặt `downloadDir`, `baseSheinAutoDir`, profiles cho user (nếu chưa set ở `.env`).
3. Tab **Cookie 4Seller**: đăng nhập 4seller.com → export cookie JSON (DevTools → Application → Cookies) → dán vào → **Lưu** → bấm **Test Cookie**. *(Thiếu cookie thì worker báo lỗi.)*
4. Lấy **API token** của user để dùng cho Tampermonkey.

## 8. Cài Tampermonkey (máy dùng để cào SHEIN)
1. Cài extension **Tampermonkey** trên Chrome.
2. Tạo userscript mới, dán nội dung `tampermonkey/sheincrawl-v27.user.js` (trong repo), lưu.
3. Mở panel script trên trang SHEIN → **⚙ Settings** → điền **Server URL** `http://localhost:3000` và **API Token** vừa lấy.

## 9. Kiểm thử end-to-end
- Cào 1 sản phẩm SHEIN bằng Tampermonkey (hoặc đặt 1 file `P5-xxx....json` vào `DOWNLOAD_DIR`).
- **File Router** (mỗi 30s) chuyển file vào folder shop; **Queue Manager** (mỗi 1 phút) chạy listing.
- Theo dõi ở Admin UI: tab **Listings** (Pending/Success/Fail, Today/Yesterday) và **History**.

---

## Ghi chú
- Cron tự chạy khi boot (`config/worker.json`: fileRouter 30s, queueManager 1 phút, `concurrency` 2). Mỗi worker mở 1 Chromium (~500MB RAM) — chú ý RAM khi tăng concurrency.
- Chế độ headless/headful do `config/worker.json` (`headless`) hoặc override per-user quyết định.
- Xem thêm `README.md` để biết mô tả tính năng.
