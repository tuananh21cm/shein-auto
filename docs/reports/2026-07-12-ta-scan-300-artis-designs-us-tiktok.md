# TikTok Shop — Overview 2026-07-12

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-12T23:32:21.551Z → 2026-07-12T23:38:49.983Z

Doanh số phục hồi tốt (3 đơn, $83.45 sau ngày trước không có đơn) và traffic tăng gấp đôi, nhưng 5 đơn quá hạn ship kéo dài từ hôm qua đang đe dọa sức khỏe shop và tồn tại 1 vi phạm critical chưa xử lý.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🔴 Nghiêm trọng | AHR 200 ổn nhưng có 1 vi phạm CRITICAL chưa gỡ; số tiền chờ quyết toán $304.67 |
| Vận hành | 🔴 Nghiêm trọng | 5 đơn shipping OVERDUE tồn từ hôm qua; 10 đơn chờ ship, mới ship 5 |
| Doanh số | 🟢 Tốt | Revenue $83.45 (từ $0), 3 đơn/4 items, refund $0, traffic tăng mạnh |
| Marketing | 🟢 Tốt | 9 KM đang chạy, 7 công cụ bật, doanh thu KM 7d $161.8; chưa tham gia campaign nào |
| Sản phẩm | 🟡 Cần chú ý | 95 SP, không thiếu/hết hàng, nhưng top view cực cao mà 0 đơn (Schoolgirl 40961 view/0 đơn) |
| Inbox | 🟡 Cần chú ý | 8 tin chưa đọc; có tin Optimization Alert (KM đã kết thúc) & AI Homepage; không có tin vi phạm/chính sách |

## 📈 Xu hướng (vs hôm qua)
- ↑ **Doanh thu** — $0 → $83.45 (từ 0 đơn lên 3 đơn)
- ↑ **Visitors** — 419 → 1043 (+149%)
- ↑ **Conversion** — 0% → 0.29%
- ↑ **Đơn chờ ship** — 6 → 10 đơn to_ship (áp lực fulfillment tăng)

## ⚠️ Cảnh báo
- 🔴 **5 đơn quá hạn giao** — action_shipping_overdue = 5, giữ nguyên từ hôm qua — rủi ro tăng late dispatch rate và phạt vận hành. → _Ship ngay 5 đơn overdue trong hôm nay, upload tracking; nếu không kịp thì liên hệ khách/hủy đúng quy trình để giảm thiệt hại chỉ số._
- 🔴 **Vi phạm nghiêm trọng chưa xử lý** — violation_critical = 1 tồn từ hôm qua, ảnh hưởng trực tiếp sức khỏe shop. → _Vào Compliance Center xem chi tiết vi phạm, nộp kháng nghị (appeal) kèm bằng chứng trong hạn để tránh khấu trừ điểm/khóa tính năng._
- 🟢 **Khuyến mãi đã kết thúc** — Tin 'Optimization Alert: Your promotion has ended' — có KM hết hạn cần thay thế. → _Tạo KM mới hoặc gia hạn để duy trì đà bán; xem AI Homepage gợi ý ưu tiên._

## 📋 Việc cần làm
1. **Xử lý 5 đơn shipping overdue (ship + tracking) ngay hôm nay** — Tồn 2 ngày, đe dọa late dispatch rate và có thể phát sinh phạt/hủy tự động
2. **Kháng nghị/khắc phục 1 vi phạm critical trong Compliance Center** — Vi phạm nghiêm trọng chưa xử lý là rủi ro khóa shop cao nhất
3. **Ship nốt các đơn còn lại trong 10 đơn chờ ship** — Đơn chờ tăng từ 6 lên 10, tránh rơi vào overdue tiếp
4. **Tối ưu listing các SP top view/0 đơn (giá, ảnh, tiêu đề, review, offer)** — Schoolgirl 40961 view & Floral Lace 33072 view nhưng 0 đơn — đang lãng phí traffic lớn
5. **Tạo/gia hạn KM thay cho khuyến mãi vừa kết thúc & xem AI Homepage** — Duy trì đà doanh số vừa phục hồi và bám gợi ý ưu tiên của TikTok
6. **Đọc & phân loại 8 tin chưa đọc trong inbox** — Đảm bảo không bỏ sót thông báo chính sách/vận hành phát sinh

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `+0` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 5 | `+0 (+0%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 10 | `+4 (+67%)` |
| orders | orders_shipped | 5 | `+4 (+400%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 0 | `+0` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 95 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | Schoolgirl Costume Set Plaid Lace Trim 3 Piece Hal — 40961 views / 0 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | 2 Piece Lingerie Set Floral Lace Heart Detail Roma — 33072 views / 0 đơn (28d), tồn 37 | |
| product-manage | top_product_3 | Lace Lingerie Set Semi-Sheer Bow Decor Romantic Da — 22432 views / 2 đơn (28d), tồn 25 | |
| product-manage | top_product_4 | Lingerie set kawaii kitty embroidered lace-up wire — 18397 views / 0 đơn (28d), tồn 16 | |
| product-manage | top_product_5 | 2 Piece Lingerie Set Spaghetti Strap Backless Cris — 12737 views / 0 đơn (28d), tồn 61 | |
| shop-overview | revenue | 83.45 USD | `+83.45` |
| shop-overview | gross_revenue | 83.45 USD | `+83.45` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 3 | `+3` |
| shop-overview | items_sold | 4 | `+4` |
| shop-overview | page_views | 1198 | `+700 (+141%)` |
| shop-overview | visitors | 1043 | `+624 (+149%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 0.29 % | `+0.29` |
| shop-overview | period | 2026-07-11T00:00:00→2026-07-12T00:00:00 | |
| promotion | promotions_ongoing | 9 | `+1 (+13%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 7 | `+1 (+17%)` |
| promotion | promotion_revenue_top_7d | 161.8 USD | `+0 (+0%)` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 0 | `+0` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 0 | `+0` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 8 | `-2 (-20%)` |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `+0` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 8 | `-2 (-20%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `+0` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 8 | `+0 (+0%)` |
| messages-marketing | msg_1 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_2 | [unread] ✅ Know exactly what to do in your shop today! Your AI Homepage is ready — Check out your new homepage that is ready to help you set your priorities straight | |
