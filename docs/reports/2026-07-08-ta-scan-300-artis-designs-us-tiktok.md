# TikTok Shop — Overview 2026-07-08

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-08T23:33:59.898Z → 2026-07-08T23:40:29.833Z

Shop có 3 đơn quá hạn giao (tăng từ 1 hôm qua) cần xử lý gấp; doanh số vẫn rất thấp (1 đơn, $31.15) với tỷ lệ chuyển đổi chỉ 0.36% dù lượng view sản phẩm lớn.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | Không có vi phạm hay tin chính sách chưa đọc; tồn kho ổn. |
| Vận hành | 🔴 Nghiêm trọng | 3 đơn quá hạn ship (hôm qua 1), 1 đơn cần ship trong 24h, 7 đơn chờ giao / 3 đã giao. Return: 0. |
| Doanh số | 🟡 Cần chú ý | Doanh thu $31.15, 1 đơn, 280 khách/331 view, CR 0.36% rất thấp; refund $0. |
| Marketing | 🟡 Cần chú ý | 7 KM đang chạy (giảm từ 8), 1 KM vừa kết thúc cần thay mới; promo doanh thu top 7d $213.37; chưa dùng Follower Coupons. |
| Sản phẩm | 🟡 Cần chú ý | 79 SP (tăng 5), SP 0 view 28d giảm mạnh còn 4; nhiều top SP view cao nhưng 0 đơn → vấn đề chuyển đổi/giá. |
| Inbox | 🟢 Tốt | Chat 0 chưa đọc, không có tin vi phạm/chính sách; chỉ tin marketing thông thường. |

## 📈 Xu hướng (vs hôm qua)
- ↑ **Đơn quá hạn ship** — 1 → 3 đơn overdue
- ↑ **Đơn chờ giao** — 4 → 7 đơn to_ship
- ↓ **SP không có view 28d** — 12 → 4 (cải thiện)
- ↓ **KM đang chạy** — 8 → 7 (1 KM đã kết thúc)

## ⚠️ Cảnh báo
- 🔴 **3 đơn quá hạn giao hàng** — Số đơn overdue tăng từ 1 lên 3, ảnh hưởng trực tiếp điểm vận hành/AHR và có nguy cơ auto-cancel. → _Xử lý ship ngay hôm nay 3 đơn quá hạn + 1 đơn ship trong 24h; nếu thiếu hàng thì liên hệ khách/điều chỉnh kịp trước hạn hủy._
- 🟡 **Tỷ lệ chuyển đổi cực thấp (0.36%)** — Top SP như Schoolgirl Costume (40k view) và Floral Lace (32k view) có 0 đơn trong 28 ngày dù view rất cao. → _Rà giá bán, ảnh, review, phí ship của các SP nhiều view/0 đơn; A/B test giá hoặc thêm coupon để chốt đơn._
- 🟢 **1 khuyến mãi vừa kết thúc** — Tin 'Your promotion has ended' và số KM giảm 8→7; chưa dùng Follower Coupons. → _Tạo KM mới thay thế và bật Follower Coupons để tận dụng lượng traffic hiện có._

## 📋 Việc cần làm
1. **Giao ngay 3 đơn quá hạn + 1 đơn ship trong 24h** — Tránh auto-cancel và tụt điểm vận hành/AHR
2. **Tối ưu chuyển đổi cho top SP nhiều view/0 đơn (giá, ảnh, coupon)** — CR 0.36% quá thấp so với lượng traffic 280 khách/ngày
3. **Tạo KM mới thay cho KM vừa kết thúc và bật Follower Coupons** — Giữ đà bán và khai thác data marketing chưa dùng
4. **Xử lý 4 SP không có view trong 28 ngày (SEO/ảnh/tag hoặc gộp)** — Tăng hiển thị, dù đã cải thiện từ 12 xuống 4

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 1 | `-1 (-50%)` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 3 | `+2 (+200%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `-1 (-100%)` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 7 | `+3 (+75%)` |
| orders | orders_shipped | 3 | `+2 (+200%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 0 | `+0` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 79 | `+5 (+7%)` |
| product-manage | products_no_views_28d | 4 | `-8 (-67%)` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | Schoolgirl Costume Set Plaid Lace Trim 3 Piece Hal — 40371 views / 0 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | 2 Piece Lingerie Set Floral Lace Heart Detail Roma — 32856 views / 0 đơn (28d), tồn 37 | |
| product-manage | top_product_3 | Lace Lingerie Set Semi-Sheer Bow Decor Romantic Da — 22218 views / 2 đơn (28d), tồn 25 | |
| product-manage | top_product_4 | Lingerie set kawaii kitty embroidered lace-up wire — 17438 views / 0 đơn (28d), tồn 16 | |
| product-manage | top_product_5 | Lace Bra Panty Set Eyelash Underwire Adjustable St — 2108 views / 0 đơn (28d), tồn 223 | |
| shop-overview | revenue | 31.15 USD | |
| shop-overview | gross_revenue | 31.15 USD | |
| shop-overview | refund_amount | 0 USD | |
| shop-overview | orders | 1 | |
| shop-overview | items_sold | 1 | |
| shop-overview | page_views | 331 | |
| shop-overview | visitors | 280 | |
| shop-overview | video_revenue | 0 USD | |
| shop-overview | conversion_rate | 0.36 % | |
| shop-overview | period | 2026-07-07T00:00:00→2026-07-08T00:00:00 | |
| promotion | promotions_ongoing | 7 | `-1 (-12%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 6 | |
| promotion | promotion_revenue_top_7d | 213.37 USD | |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 0 | `+0` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 0 | `+0` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 4 | `+0 (+0%)` |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `+0` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 4 | `+0 (+0%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `+0` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 3 | `+0 (+0%)` |
| messages-marketing | msg_1 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
