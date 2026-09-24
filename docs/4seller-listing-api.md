# 4Seller — API tạo listing TikTok (bắt được 16/09/2026, thay Playwright)

Bắt bằng `page.on("response")` trong `listing4sellerShein` (flag `data/capture-4seller-api.flag` → ghi `data/4seller-api-capture.jsonl`). Auth = **cookie 4Seller** y hệt `fourSellerPost` (`src/services/fourseller/client.ts`). Convention response `{code:0, data}`.

**Đã verify:** replay payload qua `fourSellerPost("acct:<uid>", "/api/listing/tiktok/publish", payload)` → `{code:0, listingId:860442280916}` trong **504 ms**. Playwright cùng sp: **135 s**.

## Flow tạo 1 listing (3 bước)

### 1. Lấy chữ ký upload ảnh — `POST /api/cos/get-sign` (mỗi ảnh 1 call)
```json
{"md5":"<md5 file>","fileName":"img_0.jpg","referenceType":"tiktok"}
```
→
```json
{"code":0,"data":{
  "key":"/europe-erp/<uid>/tiktok/<yyyymmdd>/0/<materialId>/<hash>.jpg",
  "sign":"q-sign-algorithm=sha1&q-ak=...&q-sign-time=...&q-signature=...",
  "sessionToken":"<Tencent COS STS token>",
  "domain":"4seller-res1.meiyunji.net",
  "localMaterialId":112153670916, "operation":"add", "url":null
}}
```

### 2. Upload file lên Tencent COS (presigned PUT, KHÔNG qua 4seller.com)
```
PUT https://{domain}{key}
Authorization: {sign}
x-cos-security-token: {sessionToken}
Content-Type: image/jpeg
<binary>
```
URL ảnh dùng trong listing = `https://{domain}{key}`. *(chưa test PUT trực tiếp — chuẩn COS; Playwright làm y vậy)*

### 3. Tạo/publish listing — `POST /api/listing/tiktok/publish`
Trả `{code:0,"data":{"code":0,"listingId":<id>,"errorMessage":null}}`. Payload (mẫu thật: `docs/samples/4seller-publish-sample.json`):

| Field | Ghi chú |
|---|---|
| `id` | `""` = tạo mới |
| `shopId`, `currentShopId` | id shop 4Seller (từ `get-tidy-list`) |
| `region` | `"LOCAL TO LOCAL"` |
| `productName` | title (đã prefix brand) |
| `categoryId`, `categoryName`, `categoryPath`, `categoryIdPath` | TikTok category **id số** + path chữ + path id (`601152/842504/601281`). Lấy từ `get-category-list`/`get-category-by-id` |
| `hasVariation` | `1` |
| `description` | HTML |
| `packageWeight/Length/Width/Height`, `dimensionUnit`, `weightUnit` | `"0.3"`,`"9"`,`"1"`,`"6"`, `CENTIMETER`, `KILOGRAM` |
| `searchTerms[]`, `productHighlights[]` | mảng string |
| `productAttributes` | **JSON string** `[{attributeId,attributeName,values:[{valueId,valueName}]}]` — id chuẩn TikTok theo category |
| `brandId`, `brandInfo` | `"0"`, `"{\"name\":\"No Brand\",\"id\":\"0\"}"` (brand chỉ nằm trong title) |
| `option1`/`option1Value` | `"{\"100000\":\"Color\"}"` / `"[{\"1001063\":\"Black\"}]"` — **attribute id + value id chuẩn TikTok** |
| `option2`/`option2Value` | `"{\"100007\":\"Size\"}"` / `"[{\"1003578\":\"XS\"},...]"` |
| `variation[]` | mỗi (color,size): `keyId, sellerSku, attrs:[color,size], availableStock:"20", originalPrice:"101.99", currency:"USD", newAdd:true, stockInfoList:[{warehouse_id, available_stock}], option1, option2` |
| `mainImage` | các COS URL nối bằng `\|` |
| `skuImgs` | **JSON string** `[{attrName:"Color", img_url:...}]` |
| `sizeChart` | COS URL ảnh size chart |
| `productCertifications` | `"[]"` |
| `sourceUrl` | link SHEIN |

## Endpoint bổ trợ (đã gọi thật, verify 16/09/2026 — dùng `fourSellerGet`)

### Attribute/option schema theo category — `GET /api/meta/tiktok/get-category-attribute-list-by-id?categoryId=<id>&site=US&shopId=<shopId>`
Trả `[{attrId, attrName, attrType, isMandatory, isMultipleSelected, isCustomized, valueList:"<JSON [{id,name}]>"}]`.
- **`attrType=2` = SALES attribute** (dùng cho `option1/option2` + `variation`): Color `attrId=100000` (102 giá trị, `Black→1001063`), Size `attrId=100007` (95 giá trị, `XS→1003578, S→1003579, M→1003580, L→1003581`). Khớp 100% payload publish.
- **`attrType=3` = product attribute** (dùng cho `productAttributes`): Pattern `100198`, Neckline `100393`, Material `100701`, Sleeve type `100396`, Dress length, Occasion… mỗi cái có `valueList` id/name.
- `isCustomized=1` → cho phép giá trị tự do. **Format custom ĐÃ CAPTURE (16/09, sp 5 màu có "Dusty Pink")**: giá trị chuẩn dùng key = valueId, giá trị lạ dùng key = **chính tên giá trị** →
  `option1Value: "[{\"1001063\":\"Black\"},{\"1002344\":\"Khaki\"},{\"Dusty Pink\":\"Dusty Pink\"},{\"1062596\":\"Light yellow\"}]"`.
  Trong `variation[]`, `attrs`/`option1` dùng tên: chuẩn thì lấy **tên theo valueList** (JSON "Light Yellow" → gửi "Light yellow"), custom thì giữ nguyên tên gốc.
- Thuộc tính tự điền mặc định (`DEFAULT_SPECIFICS` trong `listing4sellerApi.ts`): **Country of origin = USA** (attrId 100149), **Clothing length = Medium** (attrId 100394, chỉ có ở nhóm áo — đầm dùng "Dress length"). Chỉ điền khi category có field đó và SHEIN chưa map được giá trị thật vào field ấy.
- `productAttributes` KHÔNG được để `"[]"`: Playwright gửi 14 mục (3 câu compliance `"No"` + `isShow:true` từ Shipping&Certification, còn lại do `fillSpecifics` map từ SHEIN attributes). Đường API build lại bằng chính `resolveSpecifics()` với `fieldOptions` lấy từ `valueList` của `attrType=3`. Lưu ý nhãn trong `specifics-map.json` khớp **tiền tố** tên attr ("Fit" → "Fit type") vì Playwright dùng `getByPlaceholder("Select <nhãn>").first()`.
- Cache theo categoryId (schema ít đổi).

### Warehouse — `GET /api/meta/tiktok/get-warehouse-list-by-shop-id?shopId=<shopId>&fbt=0&allocationMode=`
→ `[{warehouseId:"7491288371164776234", warehouseName:"U.S Pickup Warehouse", isDefault:true, fbt:false}]`. Lấy `isDefault` → `variation[].stockInfoList[].warehouse_id`.

### Upload COS — ĐÃ VERIFY PUT THẬT
`PUT https://{domain}{key}` headers `Authorization: {sign}`, `x-cos-security-token: {sessionToken}`, `Content-Type: image/jpeg`, body = bytes thô (không multipart) → **200 / 1.27s**, HEAD lại URL → 200 `image/jpeg`. Sign hết hạn ~1h (`q-sign-time`), lấy sign mới mỗi ảnh.

**2 bẫy khi tự upload (đo thật 16/09):**
- **Phải convert sang JPEG.** Ảnh SHEIN là `.webp`; PUT nguyên bytes thì COS trả `image/webp` dù key đuôi `.jpg` (đo: 248/249 ảnh). Playwright ra `image/jpeg` 100% vì đi qua form upload của 4Seller — nó convert giùm. Dùng `sharp(buf).jpeg({quality:90})` trước khi tính md5. Giữ nguyên PNG (size chart / showcase) — Playwright cũng gửi 2 PNG.
- **Giới hạn tổng số upload đồng thời.** `Promise.all` lồng nhau (mỗi nhóm ảnh tự chạy 4 luồng × 35 màu) bung ~140 kết nối → undici ném `terminated`, hỏng cả listing. Dùng 1 hàng đợi chung `UP_LIMIT = 6` + retry 3 lần. Sp 35 màu = 249 ảnh, ~138s.

### Vòng đời trạng thái sau publish — ĐO THẬT 17/09 (listing 860646060917)
`getListingDetail(principal, listingId)` → theo dõi 2 trường:
| mốc | `publishStatus` | `erpStatus` |
|---|---|---|
| ngay sau khi tạo | `publishing` | `draft` |
| ~1 phút | `publishing` | **`suspended`** |
| ~6 phút | `normal` (TikTok cấp `productId`) | `suspended` |
| ~15 phút | `normal` | **`active`** |

**`suspended` ngay sau khi đăng là trạng thái TẠM trong lúc TikTok review — không phải bị phạt.** `errMsg` rỗng thì cứ đợi. Chỉ khi `errMsg` có nội dung mới là bị gỡ thật (vd `"…public figure's name or brand, without any brand authorization. This amounts to a trademark infringement"`). Còn `errMsg = "Listing.Back.Day_Limit"` = hết hạn mức đăng/ngày của shop.

### Brand (không cần) — `GET /api/meta/tiktok/get-brand-list-by-shop-id?shopId=` / `...-brand-suggest?brandName=`
Pipeline dùng `brandId "0"` No Brand (brand chỉ prefix vào title) → bỏ qua.

## Sơ đồ build `listing4sellerApi` (thay Playwright)
```
ScrapeResult JSON
 ├─ category  : findCategory → categoryId + categoryIdPath (get-category-list / get-category-by-id)
 ├─ schema    : get-category-attribute-list-by-id(categoryId) → map Color/Size → valueId (attrType 2), attributes → valueId (attrType 3)
 ├─ warehouse : get-warehouse-list-by-shop-id → warehouse_id
 ├─ ảnh       : với mỗi ảnh (main ≤9 KỂ CẢ showcase và showcase đứng ĐẦU, variant ≤9/màu, size chart PNG): tải → md5 → get-sign → PUT COS → URL
 ├─ text      : title/description/searchTerms/highlights (Gemini như cũ)
 └─ publish   : POST /api/listing/tiktok/publish → listingId
```
Fallback: API lỗi → chạy Playwright cũ (giữ nguyên `listing4sellerShein`).

## Đo
| | Playwright | API |
|---|---|---|
| Thời gian/listing | ~135 s | **~0.5 s** (+ upload ảnh ~vài s) |
| Browser | 1 Chromium/listing (concurrency 6) | không |
| Lỗi vặt (strict-mode, popper, virtual-list, clipboard CKEditor, toast) | nhiều | **không có** |
