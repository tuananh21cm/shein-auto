# Hướng dẫn setup Hub chung (dành cho 3 máy thành viên)

> Mục tiêu: 4 máy **dùng chung 1 Hub** để lấy sản phẩm của nhau về list.
> **Chỉ data Hub là chung.** Giá, brand, cookie, shop... **của ai người nấy giữ** — không đụng nhau.
> Khi bạn lấy listing của người khác về, hệ thống **tự áp giá/brand/cookie của CHÍNH BẠN**.

- **Máy trung tâm:** IP `172.19.0.231` (máy anh Tuấn Anh — luôn bật).
- **Folder Hub chung:** `\\172.19.0.231\shein-hub`
- **Nhánh code mới:** `homie`

⚠️ Máy bạn đang **live bản cũ (nhánh `ducbes`)** và **đã có config riêng**. Làm theo đúng thứ tự dưới đây là an toàn tuyệt đối — có sao lưu + có đường lùi.

---

## TRƯỚC KHI LÀM
- Chọn **lúc vắng việc** (sẽ restart server vài giây).
- Mở **PowerShell** tại thư mục cài shein-auto (ví dụ `C:\code\code\shein-auto`). Các lệnh dưới giả định bạn đang đứng trong thư mục đó.
- Không cần cài lại thư viện (`npm install`) — bản mới không thêm gì.

---

## BƯỚC 1 — Sao lưu (phao cứu sinh)
Chép config + .env ra chỗ an toàn. Đây là thứ DUY NHẤT git có thể đụng.

```powershell
xcopy config config-backup\ /E /I /Y
copy .env .env.backup
```

> `data\` (cookies, database, shop folder, hub cũ) đều được git bỏ qua sẵn → git **không bao giờ đụng** tới. Yên tâm.

---

## BƯỚC 2 — Dừng server đang chạy
- Bấm **Ctrl + C** ở cửa sổ đang chạy `npm start`.
- Hoặc mở Task Manager → tắt tiến trình `node`.

---

## BƯỚC 3 — Cất thay đổi chưa lưu (để đổi code sạch)
```powershell
git stash -u
```
> Lệnh này cất mọi thứ chưa commit (kể cả config bạn sửa) — **không mất gì**. Commit riêng của bạn (nếu có) vẫn nằm trên nhánh `ducbes`, không đụng tới.

---

## BƯỚC 4 — Chuyển sang code mới `homie`
```powershell
git fetch origin
git checkout homie
git pull
```

---

## BƯỚC 5 — Trả lại config riêng của bạn
```powershell
xcopy config-backup config\ /E /I /Y
```
> Giá / brand / worker... của bạn quay lại đúng như cũ. Từ giờ git **không track** mấy file này nữa nên pull code lần sau cũng **không bao giờ đè** lên.

---

## BƯỚC 6 — Trỏ Hub về máy trung tâm
Mở file `.env`, **thêm 1 dòng** (không sửa gì khác):

```
HUB_DIR=\\172.19.0.231\shein-hub
```

> Đảm bảo bạn vào được `\\172.19.0.231\shein-hub` từ File Explorer trước (gõ đường dẫn này vào thanh địa chỉ). Nếu bị hỏi user/mật khẩu → nhập tài khoản Windows của máy trung tâm, tích **Remember**.

---

## BƯỚC 7 — Bật lại server
```powershell
npm start
```
Mở admin (`http://localhost:3000`) → vào tab **Hub sản phẩm** → thấy sản phẩm của cả đội là **thành công**.

---

## BƯỚC 8 — Đẩy data cũ của bạn lên Hub chung
Thay `<tên_bạn>` bằng tên của bạn (để đội biết ai cào):

```powershell
npm run hub:import-local -- --by=<tên_bạn>
```
> Lệnh này quét sản phẩm cũ ở máy bạn (`data\hub` + `Downloads\SheinAuto`), **tự loại trùng**, gắn tên bạn, rồi đẩy lên Hub chung. Chạy **1 lần duy nhất**.

---

## ✅ XONG — Kiểm tra
- Tab **Hub sản phẩm**: thấy danh sách chung, mỗi sản phẩm có nhãn **🧑 tên người cào**.
- Lọc **👥 Cả đội / 🙋 Của tôi** ở đầu Hub.
- Lấy 1 sản phẩm của người khác → **📤 List lên shop** → nó vào shop của **bạn**, dùng **giá/brand/cookie của bạn**.

---

## ⏪ NẾU CÓ SỰ CỐ → LÙI VỀ BẢN CŨ NGAY
```powershell
# Tắt server (Ctrl+C) rồi chạy:
git checkout ducbes
xcopy config-backup config\ /E /I /Y
copy .env.backup .env
npm start
```
→ Về đúng bản cũ như chưa làm gì. Báo anh Tuấn Anh để xử lý.

---

## 📌 QUY TẮC VÀNG (nhớ kỹ)
1. **Làm việc trên nhánh `homie`** (gõ `git branch`, thấy dấu `*` ở `homie` là đúng).
2. **TUYỆT ĐỐI KHÔNG** chạy `git push origin ducbes` — sẽ đè code người khác.
3. **Giá / brand / cookie là của riêng bạn** — sau khi setup xong nhớ **kiểm tra lại giá + brand ở tab Settings** trước khi list.
4. **Máy trung tâm (172.19.0.231) phải luôn bật** thì mới vào được Hub. Máy đó tắt → cả đội tạm mất Hub (data vẫn còn, bật lại là có).
5. Cào sản phẩm mới (bằng userscript v30) → tự đẩy vào Hub chung → cả đội thấy ngay.

---

## ❓ Xử lý lỗi thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| Không mở được `\\172.19.0.231\shein-hub` | Kiểm tra cùng mạng LAN; máy trung tâm đã bật + đã share folder chưa; thử ping `172.19.0.231`. |
| Vào Hub báo lỗi / trống | Kiểm tra dòng `HUB_DIR` trong `.env` đúng chưa; đã restart server sau khi sửa `.env` chưa. |
| Sau pull mất file config (giá/brand) | Chạy lại Bước 5 (`xcopy config-backup config\ /E /I /Y`), hoặc copy từ `config\*.example.json` rồi set lại qua Settings. |
| `git checkout homie` báo vướng | Chạy `git stash -u` (Bước 3) rồi checkout lại. |
| Giá list ra sai | Vào **Settings → Pricing** chỉnh lại giá của bạn (giá là riêng từng máy). |

---

*File này gửi kèm khi cần. Thắc mắc hỏi anh Tuấn Anh.*
