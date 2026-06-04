# SHEIN US — Bản đồ Route & Endpoint cho Win Research

> Mục tiêu: liệt kê mọi route/endpoint của `us.shein.com` để khai thác **ngách**,
> **sản phẩm win**, **sold/review/rating**, **bestseller rank**, **new release**,
> **local (dropship US)** — làm nền cho module Win Intelligence Engine.
>
> Nguồn: nav live (06/2026) + golden BFF responses (`data/kiki-debug/`) +
> HAR homepage (`data/network-trace/shein-home.har`) + RapidAPI client hiện có.

---

## 0. Kết luận then chốt về cách lấy dữ liệu

| Kênh | Bot-risk | Dùng cho |
|---|---|---|
| **RapidAPI** (shein-data-api, shein-online-data) — ĐÃ tích hợp | ❌ Không | search, best-by-category, detail, store keywords/quantity, categories. **Quét diện rộng hằng ngày.** |
| **Kiki anti-detect browser** — ĐÃ tích hợp | ✅ Né được | Bắt BFF nội bộ (sold thật, rank, review floor) + crawl store theo scroll. **Làm giàu top candidate.** |
| **Browser thường (Playwright/agent-browser)** | ⛔ Bị chặn ngay (`/risk/action/limit`) | KHÔNG dùng để cào. Chỉ debug. |

> ⚠️ Test 06/2026: mở `us.shein.com` rồi click category bằng Chrome thường → redirect
> `risk/action/limit?risk-id=...` sau 1 click. Mọi crawl thật **bắt buộc** đi qua Kiki hoặc RapidAPI.

---

## 1. Route tree (cây website — navigable)

### Top-level categories (nav chính, 26 nhánh)
```
New In · Sale · Women Clothing · Beachwear · Kids · Curve · Men Clothing ·
Shoes · Underwear & Sleepwear · Home & Living · Jewelry & Accessories ·
Beauty & Health · Baby & Maternity · Bags & Luggage · Sports & Outdoors ·
Home Textiles · Cell Phones & Accessories · Electronics · Toys & Games ·
Tools & Home Improvement · Office & School Supplies · Pet Supplies ·
Appliances · Automotive · Books & Magazine · Food & Beverages
```

### URL patterns (nhận diện loại trang)
| Loại trang | Pattern | Tín hiệu khai thác |
|---|---|---|
| Category (selection) | `/RecommendSelection/<Name>-sc-<scId>.html` | list sp theo ngách |
| Category (cũ) | `/<Name>-c-<catId>.html` | list sp theo ngách |
| Product detail | `/...-p-<goodsId>.html` | sold/review/rank/attr |
| Store | `/store/home?store_code=<code>&type=selection` | catalog đối thủ |
| **Bestseller / Ranking** | `/sales/ranking_list?data=%7B...cate_id...rank_strategy...%7D` | **No.1..N theo ngách** |
| Search | `/pdsearch/<keyword>/` | win theo keyword |
| New In | nav "New In" → daily-new feed | **new release** |
| Sale | nav "Sale" | discount cao |

> `ranking_list` payload (golden-0) chứa: `cate_id`, `goods_rank`, `rank_strategy`,
> `rankingTypeText: "Bestseller"`, `rankingBannerText: "No.1 Bestseller"`,
> `composeIdText: "in 10 Piece Set Women Thongs"` → **tên ngách + thứ hạng tuyệt đối**.

---

## 2. BFF endpoints nội bộ (qua Kiki — giàu tín hiệu nhất)

### 2.1 Trang detail sản phẩm (xác nhận từ golden files)
| Endpoint | Field vàng | Ý nghĩa |
|---|---|---|
| `/bff-api/product/get_goods_detail_realtime_data` | `last90DaysSoldNum` ("6.6k+"), `comment_num(_show)`, `comment_rank_average`, `fiveStarRating` | **SOLD 90 ngày + review + rating + %5★** — tín hiệu win mạnh nhất |
| `/bff-api/category/api/get_detail_rank_info` | `scoreStr` ("No.1"), `cate_id`, `rankingTypeText`, `composeIdText` | **Bestseller rank trong ngách** |
| `/bff-api/product/get_goods_detail_static_data_v2` | attr, ảnh, size, material | data tĩnh để dựng listing |
| `/bff-api/product/comment/get_buyer_show_floor` | ảnh/đánh giá người mua | social proof, ảnh thật |
| `/bff-api/product/detail_recommend_info` | sp liên quan | mở rộng ngách |
| `/bff-api/product/get_new_companion_module` | mua kèm | bundle / combo win |

> Đã có `productStats.ts` bắt đúng `get_goods_detail_realtime_data`. Cần bổ sung capture
> `get_detail_rank_info` (rank) + `get_buyer_show_floor` (ảnh review).

### 2.2 Navigation / category (xác nhận từ HAR)
| Endpoint | Dùng cho |
|---|---|
| `/bff-api/ccc/nav/right` | **cây nav đầy đủ → bản đồ ngách** (toàn bộ sub-category) |
| `/bff-api/navigation-api/transfer/mapping_config` | map slug ↔ catId |
| `/bff-api/abt/merge/*` | A/B config (bỏ qua) |

### 2.3 List sản phẩm theo category (productList)
Bị anti-bot chặn khi click thường, nhưng **Kiki `storeCrawler.ts` đã intercept được**
các JSON list khi scroll (tìm mảng có `goods_id`). Cùng cơ chế áp cho trang category/ranking:
mở bằng Kiki → scroll → gom `goods_id`, `comment_num`, `rating`, `salePrice/retailPrice`.

---

## 3. RapidAPI (đã tích hợp — quét diện rộng, không bot-risk)

`src/services/shein/client.ts`:
| Hàm | Endpoint | Tín hiệu |
|---|---|---|
| `searchProducts` | `/search/v2?query=&countryCode=us` | win theo keyword (có review+rating) |
| `bestSellersByCategory` | `/product/bycategory/best?categoryId=` | **best-seller theo ngách** |
| `recommendedProducts` | `/product/recommended?goodsId=` | mở rộng ngách |
| `getCategories` | `/categories?countryCode=us` | **cây ngách** |
| `getStoreKeywords` | `/store/keywords?storeCode=` | ngách top của 1 shop |
| `getStoreQuantity` | `/store/products/quantity` | quy mô catalog đối thủ |
| `getProductDetail` | online `/api/product/{id}` + fallback | attr/ảnh/material |

---

## 4. Bản đồ tín hiệu → score

| Tín hiệu | Nguồn tốt nhất | Field |
|---|---|---|
| **Sold 90 ngày** | Kiki BFF | `last90DaysSoldNum` |
| **Review count** | RapidAPI / BFF | `comment_num(_show)` |
| **Rating** | RapidAPI / BFF | `comment_rank_average` |
| **% 5 sao** | Kiki BFF | `fiveStarRating` |
| **Bestseller rank** | Kiki BFF | `get_detail_rank_info.scoreStr` |
| **Giá / discount** | RapidAPI | `salePrice` / `retailPrice` |
| **New release** | route New In + sort=new | ngày đăng / cờ new |
| **Niche tree** | BFF `ccc/nav/right` + RapidAPI categories | cat tree |
| **Local (dropship US)** | `countryCode=us` + cờ "SHEIN-shipped" + lớp weather/trend | warehouse/ship US |

### "Local" cho dropshipping
- Mọi API gọi với `countryCode=us` → giá/tồn/ship đúng thị trường bán.
- Ưu tiên sp **"SHEIN-shipped / Free Shipping $29+"** (ship nội địa nhanh → ít hoàn, hợp dropship).
- Ghép lớp **mùa vụ US** (thời tiết/trend) ở tầng demand để chọn đúng thời điểm.

---

## 5. 4 route khai thác win hằng ngày (đề xuất)

1. **Best-seller sweep** — duyệt `bestSellersByCategory` cho từng sub-category US (RapidAPI) → pool ứng viên rộng.
2. **Ranking deep-dive** — top ứng viên → mở `ranking_list`/detail bằng Kiki → lấy sold thật + rank "No.X Bestseller".
3. **New-In radar** — quét route New In + sort=new → bắt sp đang lên sớm (ít cạnh tranh).
4. **Competitor mirror** — `similarStores` + crawl store đối thủ (Kiki) → copy ngách+sp đang bán chạy.

→ Hợp nhất → chấm `opportunityScore` → Candidate List hằng ngày.
