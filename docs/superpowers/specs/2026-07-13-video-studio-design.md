# Video Studio — Spec thiết kế

**Ngày:** 2026-07-13
**Trạng thái:** Đã được user duyệt (thiết kế trình bày trong session brainstorming)

## 1. Mục tiêu

Module mới trong shein-auto: từ data view/sold per-product có sẵn → **đề xuất sản phẩm
tiềm năng** → **kéo ảnh sản phẩm từ 4Seller** → **gen video TikTok 9:16 hoàn chỉnh**
(voiceover EN + caption sync + nhạc nền, hiệu ứng Ken Burns trên ảnh) → **quản lý /
review / download** trong admin UI hiện có.

**Ngoài scope (phase sau):** auto-post lên TikTok, export ảnh carousel (Photo Mode),
thống kê video nào ra đơn.

## 2. Quyết định đã chốt

| Quyết định | Lựa chọn | Lý do |
|---|---|---|
| Kiểu video | Voiceover + caption sync + nhạc nền | Chuẩn TikTok US, engagement cao nhất |
| Chọn sản phẩm | Hệ thống tự đề xuất (có đơn / đang lên / nhiều view) | User yêu cầu; data `listing_views` đã có sẵn |
| Đăng video | KHÔNG auto-post — chỉ gen + quản lý + download, đăng tay | An toàn account, scope gọn |
| Render engine | FFmpeg thuần (đã có trên máy, bản full-build gyan.dev) | Không thêm stack, render ~5–15s/video, template = code TS dễ random hóa |
| TTS | Edge TTS qua npm `msedge-tts` (free, có word-boundary timestamps) | $0, giọng Microsoft neural đủ tốt cho TikTok |
| LLM script | Gemini (service + `retryGemini` đã có trong project) | Tái dùng hạ tầng |
| Vị trí code | Module trong shein-auto (không tách repo) | Tái dùng 4Seller client, cookie, Gemini, `listing_views` DB, admin server |

## 3. Luồng dữ liệu

```
listing_views DB (pv_28d / orders_28d / gmv_28d — tiktokCron cào hằng ngày, ĐÃ CÓ)
        │
[1] suggestProducts ── đề xuất SP: có đơn / đang lên / nhiều view
        │              (tái dùng logic getFlashCandidates / getRisingListings)
        ▼
[2] fetchImages ────── 4Seller getListingDetail(listingId) → tải images[]
        │              → sharp: crop/pad 1080x1920 + remakeImage (chống trùng)
        ▼
[3] genScript ──────── Gemini: {hook, lines[], cta} tiếng Anh, đọc ~25–35s
        ▼
[4] tts ────────────── msedge-tts → voice.mp3 + word timestamps (random giọng US)
        ▼
[5] renderVideo ────── FFmpeg: zoompan từng ảnh + xfade + caption .ass sync
        │              + nhạc nền duck dưới voice → H.264 1080x1920
        ▼
data/videos/<shop>/<productId>_<n>.mp4 + row trong bảng `videos` (SQLite)
        ▼
[6] UI videos.html ─── tab "Đề xuất" + tab "Thư viện" (preview/download/đã đăng/regen)
```

## 4. Components

### 4.1 `src/core/videoStudio/suggestProducts.ts`
- Input: shop (hoặc all), ngưỡng (risingPerDay, topViewPv — mặc định như flash module).
- Lấy candidates từ `TikTokDb` (`services/tiktok/db.ts`) — sản phẩm có ≥1 tín hiệu:
  `orders_28d > 0` / `avgPerDay ≥ risingPerDay` / `pv_28d ≥ topViewPv`, kèm `reasons[]`.
- **Map sang 4Seller:** pull active listings của shop qua `getListingPage` (paginate),
  index theo `productId` → match với `listing_views.product_id` để có `listingId` +
  thumbnail (`mainImage`). Map tên shop `listing_views.shop` ↔ 4Seller
  `platformShopName` (so khớp không phân biệt hoa thường; không match được → bỏ qua
  row + log).
- Output: `{productId, listingId, shopId, shopName, title, thumb, pv, avgPerDay,
  orders, reasons, hasVideo}` — `hasVideo` = đã có video `ready|posted` trong DB.

### 4.2 `src/core/videoStudio/fetchImages.ts`
- `getListingDetail(principal, listingId)` → mảng `images` (URL).
- Download về `data/videos/assets/<productId>/src_N.jpg` (skip nếu đã có — cache
  dùng chung mọi video của sản phẩm).
- Xử lý sharp mỗi ảnh → `data/videos/assets/<productId>/<videoId>/img_N.jpg`
  1080x1920 (per-video vì seed remake khác nhau giữa các video):
  - Ảnh vuông/ngang: cover-crop phần trung tâm + nếu cần thì blur-pad nền.
  - Chạy `remakeImage` (preset `standard`, seed = `<productId>:<videoN>:<i>`) để
    chống trùng fingerprint.
- Lấy tối đa 8 ảnh, tối thiểu 3 (ít hơn → lỗi rõ ràng "không đủ ảnh").

### 4.3 `src/services/gemini/genVideoScript.ts`
- Input: title, attributes/description, giá (từ listing detail).
- Output JSON: `{hook: string, lines: string[], cta: string}` — tiếng Anh, tổng
  ~70–90 từ (~25–35s đọc). Hook ≤ 10 từ, giật tít kiểu TikTok.
- Dùng `retryGemini` util sẵn có; validate JSON, retry nếu parse fail.

### 4.4 `src/services/tts/edgeTts.ts` (dependency mới duy nhất: `msedge-tts`)
- Input: text (hook + lines + cta nối lại), voice.
- Voice pool: ~4–6 giọng en-US nam/nữ (vd `en-US-JennyNeural`, `en-US-GuyNeural`,
  `en-US-AriaNeural`, `en-US-ChristopherNeural`), random theo seed video.
- Output: `voice.mp3` + `words: {text, startMs, endMs}[]` (từ WordBoundary events).
- Retry 3 lần (service free đôi khi chập chờn).

### 4.5 `src/core/videoStudio/buildAss.ts`
- Input: word timestamps + style seed.
- Nhóm 2–4 từ thành 1 dòng caption, hiện đúng theo timestamps.
- 3–5 style preset (font/size/màu/viền/vị trí y) — chọn theo seed. Font dùng font
  Windows sẵn có (Arial Black, Impact, Verdana Bold…).
- Hook overlay ở ~1.5s đầu + CTA ở cuối cũng nằm trong file .ass (event riêng,
  style riêng) — không dùng drawtext để khỏi escape text trong filtergraph.
- Output: file `.ass` hoàn chỉnh.

### 4.6 `src/core/videoStudio/renderVideo.ts`
- Input: danh sách ảnh, voice.mp3, file .ass, nhạc nền (nếu có), seed.
- Kế hoạch segment: duration video = duration voice + 0.8s tail; chia đều cho N ảnh
  (mỗi ảnh 2.5–5s; thừa ảnh thì bỏ bớt, thiếu thì lặp lại từ đầu danh sách).
- Filtergraph: mỗi ảnh 1 `zoompan` (zoom in HOẶC out 1.0↔1.12, pan hướng random theo
  seed) → nối bằng `xfade` (fade/slideleft/slideup… random) → `ass=` caption.
- Audio: `amix` voice + nhạc nền (nhạc -16dB dưới voice, `afade` out cuối). Không có
  file nhạc → chỉ voice.
- Encode: H.264 yuv420p, CRF 21, preset veryfast, AAC 128k, 1080x1920 @30fps.
- Spawn ffmpeg (child_process), timeout 120s, capture stderr → message lỗi.
- Random hóa chống trùng — tất cả theo seed video: giọng đọc, nhạc, thứ tự ảnh,
  hướng zoom/pan, kiểu transition, style caption, remake preset seed.

### 4.7 `src/state/videoDb.ts`
- SQLite riêng `data/videos.db` (better-sqlite3, pattern như các store hiện có).
- Bảng `videos`: `id, shop, product_id, listing_id, title, status, file, script_json,
  voice, seed, error, created_at, updated_at, posted_at`.
- Status flow: `queued → generating → ready | error`; `ready → posted` (user đánh dấu).
- 1 sản phẩm có thể có nhiều video (regen tạo row mới, seed mới).

### 4.8 `src/core/videoStudio/videoQueue.ts`
- Queue tuần tự in-process (1 job render 1 lúc — tránh nghẽn CPU), pattern giống
  queue hiện có của project.
- Job steps: fetchImages → genScript → tts → buildAss → render → `ready`.
- Emit progress qua `eventBus` (đã có) → UI nhận qua SSE `/admin/api/events/stream`.
- Step fail → `status=error` + message + step name. Retry chạy lại TỪ step fail
  (ảnh/script/audio đã có trên disk thì tái dùng).

### 4.9 UI + routes
- Trang mới `src/public/videos.html` (không nhét thêm vào admin.html vốn đã ~2000 dòng),
  link từ menu admin. Routes mới trong `adminServer.ts`:
  - `GET  /admin/api/videos/suggest?shop=&limit=` — danh sách đề xuất (4.1)
  - `POST /admin/api/videos/create` — body `{items: [{productId, listingId, shop}], count?}` → enqueue
  - `GET  /admin/api/videos` — list video + status (filter shop/status)
  - `GET  /admin/api/videos/file/:id` — stream mp4 (preview/download)
  - `POST /admin/api/videos/:id/retry` · `POST /admin/api/videos/:id/posted` · `DELETE /admin/api/videos/:id`
- Tab **Đề xuất**: bảng SP (thumb, title, pv, đà tăng/ngày, orders, reasons, đã có video
  chưa) + checkbox chọn nhiều + nút "Tạo video".
- Tab **Thư viện**: grid card video (`<video>` preview, status badge, download, đánh dấu
  đã đăng, regen, xóa). Progress realtime qua SSE.

## 5. Cấu hình & assets

- Principal 4Seller: dùng cùng cơ chế principal/cookie như các module hiện có
  (config trong appConfig / per-account cookie).
- Nhạc nền: user tự bỏ mp3 (nhạc được phép dùng commercial) vào `data/videos/music/`.
  Thư mục rỗng → video chỉ có voice, không lỗi.
- Font: dùng font hệ thống Windows, không bundle font.
- Dependency npm mới: **chỉ `msedge-tts`**.

## 6. Error handling

- Mỗi step lỗi → row `videos.status=error`, lưu step + message cụ thể (vd
  "TTS timeout sau 3 lần", "FFmpeg exit 1: <stderr tail>", "Chỉ có 2 ảnh, cần ≥3").
- Gemini: `retryGemini` + validate JSON schema output.
- TTS: retry 3 lần, backoff ngắn.
- FFmpeg: timeout 120s/video, kill process khi timeout.
- Download ảnh: timeout 30s/ảnh, lỗi 1 ảnh vẫn tiếp tục nếu còn ≥3 ảnh OK.

## 7. Testing

- Unit (vitest có sẵn):
  - `buildAss`: word timestamps → ASS đúng format, nhóm từ đúng, thời gian khớp.
  - `genVideoScript`: parse/validate JSON output (mock Gemini).
  - Segment plan trong `renderVideo`: N ảnh + duration audio → durations từng segment
    khớp tổng, xử lý thiếu/thừa ảnh.
- Smoke: `src/scripts/testVideoRender.ts` — render 1 video từ ảnh mẫu có sẵn trong
  repo (`src/core/steps/temp_images_*`), bỏ qua Gemini/4Seller (script hardcode),
  chạy được offline trừ TTS.

## 8. Rủi ro & lưu ý

- `msedge-tts` là service free không chính thức → có thể đổi API; bọc sau interface
  `TtsEngine` để sau này swap OpenAI TTS chỉ cần 1 file.
- Map shop name `listing_views` ↔ 4Seller dựa trên tên — nếu user đổi tên shop sẽ
  lệch; log rõ khi không match được.
- Ảnh Shein có thể chứa watermark/text — `remakeImage` crop nhẹ giúp một phần;
  chấp nhận ở phase này.
