# TikTok Shop — Overview 2026-07-09

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl ok · 2026-07-09T23:27:34.274Z → 2026-07-09T23:31:04.784Z

Doanh thu tăng mạnh gấp đôi và conversion cải thiện rõ, nhưng shop đang có 1 vi phạm nghiêm trọng và 4 đơn quá hạn giao — cần xử lý gấp để tránh phạt.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🔴 Nghiêm trọng | AHR 200 tốt, violation_score 0 nhưng có 1 vi phạm critical đang tồn; cần settle $284.81 |
| Vận hành | 🔴 Nghiêm trọng | 4 đơn quá hạn giao (tăng từ 3), 1 đơn phải ship trong 24h, 8 đơn chờ giao |
| Doanh số | 🟢 Tốt | Revenue $72.66 (+133% so hôm qua), 3 đơn, conversion 4.48%, refund $0 |
| Marketing | 🟡 Cần chú ý | 8 khuyến mãi đang chạy, nhưng promo revenue 7d giảm còn $116.95 (từ $213.37); 1 promo đã kết thúc |
| Sản phẩm | 🟡 Cần chú ý | 95 SP, 16 SP không có view 28d (tăng từ 4); top SP nhiều view nhưng 0 đơn — kém chuyển đổi |
| Inbox | 🟢 Tốt | Không có tin vi phạm/chính sách chưa đọc; 2 tin marketing (promo ended) |

## 📈 Xu hướng (vs hôm qua)
- ↑ **Doanh thu** — $31.15 → $72.66 (+133%)
- ↑ **Conversion** — 0.36% → 4.48%
- ↓ **Lượt truy cập** — visitors 280 → 67 (-76%), page_views 331 → 98
- ↑ **Đơn quá hạn giao** — 3 → 4 đơn
- ↓ **Promo revenue 7d** — $213.37 → $116.95 (-45%)
- ↑ **SP không view 28d** — 4 → 16 SP (do thêm SP mới)

## ⚠️ Cảnh báo
- 🔴 **Vi phạm nghiêm trọng đang tồn** — Có 1 violation_critical dù violation_score = 0. Vi phạm critical có thể dẫn tới hạn chế/khóa shop nếu không xử lý. → _Vào Compliance Center xem chi tiết vi phạm, kháng nghị (appeal) nếu sai hoặc khắc phục ngay theo hướng dẫn_
- 🔴 **4 đơn quá hạn giao + 1 đơn sắp tới hạn** — Đơn quá hạn ship tăng từ 3 lên 4, ảnh hưởng trực tiếp tới late dispatch rate và sức khỏe shop. → _Ship ngay 4 đơn quá hạn và 1 đơn trong 24h; nếu thiếu hàng thì liên hệ khách hoặc xử lý huỷ đúng quy trình_
- 🟢 **Lượt truy cập giảm mạnh** — Visitors giảm 76% so hôm qua dù conversion cao — có thể do một chiến dịch/traffic nguồn đã dừng. → _Kiểm tra nguồn traffic và promo vừa kết thúc, cân nhắc gia hạn hoặc tạo khuyến mãi mới_

## 📋 Việc cần làm
1. **Xử lý vi phạm critical trong Compliance Center** — Vi phạm nghiêm trọng có nguy cơ phạt/hạn chế shop
2. **Giao ngay 4 đơn quá hạn + 1 đơn trong 24h** — Tránh tăng late dispatch rate và tụt AHR
3. **Tạo/gia hạn khuyến mãi thay cho promo vừa kết thúc** — Promo revenue 7d giảm 45% và traffic giảm mạnh
4. **Tối ưu 16 SP không có view 28d (ảnh, tiêu đề, giá, gắn video)** — Nhiều SP không hiển thị làm lãng phí danh mục
5. **Cải thiện chuyển đổi top SP nhiều view nhưng 0 đơn (Schoolgirl, Floral Lace...)** — 40k+ view nhưng 0 đơn là cơ hội doanh thu lớn đang bỏ lỡ

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| homepage | ahr_score | 200 score | |
| homepage | violation_score | 0 score | |
| homepage | violation_total | 1 | |
| homepage | violation_critical | 1 | |
| homepage | violation_fulfillment | 0 | |
| homepage | has_new_violation | false | |
| homepage | to_settle_amount | 284.81 USD | |
| homepage | orders_total | 11 | |
| orders | action_ship_within_24h | 1 | `+0 (+0%)` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 4 | `+1 (+33%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 8 | `+1 (+14%)` |
| orders | orders_shipped | 2 | `-1 (-33%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 0 | `+0` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 95 | `+16 (+20%)` |
| product-manage | products_no_views_28d | 16 | `+12 (+300%)` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | Schoolgirl Costume Set Plaid Lace Trim 3 Piece Hal — 40701 views / 0 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | 2 Piece Lingerie Set Floral Lace Heart Detail Roma — 32916 views / 0 đơn (28d), tồn 37 | |
| product-manage | top_product_3 | Lace Lingerie Set Semi-Sheer Bow Decor Romantic Da — 22296 views / 2 đơn (28d), tồn 25 | |
| product-manage | top_product_4 | Lingerie set kawaii kitty embroidered lace-up wire — 18071 views / 0 đơn (28d), tồn 16 | |
| product-manage | top_product_5 | Lace Bra Panty Set Eyelash Underwire Adjustable St — 2167 views / 0 đơn (28d), tồn 223 | |
| shop-overview | revenue | 72.66 USD | `+41.51 (+133%)` |
| shop-overview | gross_revenue | 72.66 USD | `+41.51 (+133%)` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 3 | `+2 (+200%)` |
| shop-overview | items_sold | 3 | `+2 (+200%)` |
| shop-overview | page_views | 98 | `-233 (-70%)` |
| shop-overview | visitors | 67 | `-213 (-76%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 4.48 % | `+4.12 (+1144%)` |
| shop-overview | period | 2026-07-08T00:00:00→2026-07-09T00:00:00 | |
| promotion | promotions_ongoing | 8 | `+1 (+14%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 6 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 116.95 USD | `-96.42 (-45%)` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 0 | `+0` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 0 | `+0` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 2 | `-2 (-50%)` |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `+0` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 2 | `-2 (-50%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `+0` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 2 | `-1 (-33%)` |
| messages-marketing | msg_1 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
