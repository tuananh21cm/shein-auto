# 4Seller Flash Deal — API contract (capture 2026-07-09)

Bắt qua Chrome CDP + cookie 4Seller. Cả 2 endpoint POST, auth bằng cookie (fourSellerPost).

## 1. List sản phẩm đủ điều kiện flash

`POST /api/listing/tiktok/page-search`

Payload:
```json
{
  "pageCurrent": 1, "pageSize": 100,
  "searchValue": [], "searchType": "all",
  "status": "active",
  "shopId": 224844,
  "activityStartTime": 1783610946085,   // ms — khoảng thời gian flash
  "activityEndTime": 1783870146085,
  "hasActivity": false,
  "activityType": "FLASHSALE"
}
```
Response `data.records[]` (chỉ sp CHƯA nằm flash khác trong khoảng đó):
```
{ listingId, productId, image, productName, hasVariation, originalPrice, currency, stock,
  skus: [ { variationId, productVariationId, msku, variations, originalPrice, stock,
            activityPriceAmount:null, discount:null, quantityLimit:null, quantityPerUser:null } ] }
```
- `productId` = TikTok product_id → **khớp listing_views.product_id** (map candidate trực tiếp).
- `total`, `idList` cũng có. Phân trang pageSize 100.

## 2. Tạo / publish flash

`POST /api/promotion/tiktok/activity/add-or-update`

Payload (variation-level, 24% off):
```json
{
  "shopId": 224844,
  "shopCurrency": "",
  "activityName": "FLASH <shop> <ngày>",
  "beginTime": 1783611995109,   // ms
  "endTime": 1783871195109,     // ms (period mặc định ~ +3 ngày)
  "discountType": "FLASHSALE",
  "productLevel": "VARIATION",
  "products": [ <product> ]
}
```
`products[]` item = record từ page-search + skus có giá deal:
```
{ listingId, productId, image, productName, hasVariation:1, originalPrice, currency, stock,
  activityPriceAmount:null, discount:null, quantityLimit:null, quantityPerUser:null,
  skus: [ <sku> ] }
```
`skus[]` item — CHỖ đặt giảm giá:
```
{ listingId, variationId, productId, msku, productVariationId, variations, currency, stock,
  hasAdd:1, originalPrice: 35.44,
  activityPriceAmount: "26.94",              // = giá deal = round(originalPrice*(1-0.24), 2)
  activityPriceAmountPercentage: "24",       // = % off
  discount:null, quantityLimit:null, quantityPerUser:null, warningMessage:"", errorMessage:"" }
```

### Cách build products[] từ page-search
1. `page-search(shopId, start, end)` → records đủ điều kiện.
2. Lọc record có `productId` ∈ danh sách `getFlashCandidates(shop, 30)`.
3. Mỗi record: giữ nguyên các trường, với mỗi sku set:
   - `activityPriceAmountPercentage = "24"`
   - `activityPriceAmount = (originalPrice * 0.76).toFixed(2)`
   - `hasAdd = 1`
4. POST add-or-update.

## Ghi chú
- Shop "beckyb" có shopId **224844** (lấy từ get-tidy-list / getShopList records[].id).
- Chỉ sp CHƯA có flash trong khoảng thời gian đó mới nằm trong page-search → tự né trùng.
- Kiểm response add-or-update `code==0/success` để biết publish OK.
