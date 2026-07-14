# TikTok Shop — Overview 2026-07-11

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl ok · 2026-07-11T23:34:34.752Z → 2026-07-11T23:38:10.924Z

Shop có 1 vi phạm nghiêm trọng và 5 đơn quá hạn giao chưa xử lý, cần hành động ngay. AHR vẫn ổn (200), tồn kho và sản phẩm không có vấn đề, nhưng doanh thu hôm qua bằng 0 dù 419 khách ghé thăm.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🔴 Nghiêm trọng | AHR 200 (tốt) nhưng có 1 vi phạm CRITICAL cần xử lý. Chờ quyết toán $304.67. |
| Vận hành | 🔴 Nghiêm trọng | 5 đơn QUÁ HẠN GIAO, 6 đơn chờ ship, chỉ 1 đơn đã ship. Không có yêu cầu hoàn/trả tồn. |
| Doanh số | 🟡 Cần chú ý | Doanh thu $0, 0 đơn dù 419 khách/498 lượt xem → conversion 0%. Tương tác cao nhưng không chốt. |
| Marketing | 🟡 Cần chú ý | 8 KM đang chạy, doanh thu KM top 7d $161.8, nhưng 0 chiến dịch tham gia và 1 KM vừa kết thúc. |
| Sản phẩm | 🟢 Tốt | 95 SP, 0 hết hàng/tồn thấp/0 view. Top SP nhiều view (40k/33k) nhưng 0 đơn 28d → vấn đề chuyển đổi. |
| Inbox | 🟡 Cần chú ý | 10 tin chưa đọc (0 vi phạm/chính sách), gồm yêu cầu hoàn tiền và cảnh báo KM kết thúc. |

## ⚠️ Cảnh báo
- 🔴 **Vi phạm nghiêm trọng (critical) đang tồn tại** — Có 1 violation ở mức critical (violation_total=1, violation_critical=1). Nếu không xử lý có nguy cơ ảnh hưởng sức khỏe shop và risk khóa. → _Vào Compliance/Violations xem chi tiết vi phạm, khắc phục nguyên nhân và nộp appeal nếu đủ căn cứ ngay hôm nay._
- 🔴 **5 đơn quá hạn giao hàng** — action_shipping_overdue=5 — đơn đã vượt hạn ship, ảnh hưởng trực tiếp AHR (late dispatch/on-time) và có thể phát sinh vi phạm fulfillment. → _Xử lý ngay 5 đơn overdue: mua/lấy nhãn vận chuyển và mark shipped, kiểm tra tồn thực và liên hệ khách nếu chậm._
- 🟡 **Yêu cầu hoàn tiền mới trong Inbox** — Có tin 'Return/Refund Request Received' chưa đọc. Cần phản hồi trong 24h để tránh auto-approve. → _Mở tab Return/Refund, xem yêu cầu và phản hồi trong hạn 24h._
- 🟢 **Khuyến mãi vừa kết thúc** — Marketing báo 'promotion has ended'. Không có KM sắp diễn ra (upcoming=0). → _Tạo KM mới nối tiếp để giữ đà, cân nhắc tham gia campaign nền tảng (hiện joined=0)._

## 📋 Việc cần làm
1. **Xử lý vi phạm critical: xem chi tiết, khắc phục, nộp appeal** — Vi phạm nghiêm trọng có nguy cơ hạ AHR và khóa shop
2. **Ship ngay 5 đơn quá hạn + 6 đơn chờ ship** — Đơn overdue ảnh hưởng on-time rate và có thể tạo vi phạm fulfillment
3. **Phản hồi yêu cầu hoàn/trả trong Inbox trong 24h** — Tránh tự động duyệt hoàn tiền gây thiệt hại
4. **Điều tra vì sao 419 khách nhưng 0 đơn — kiểm tra giá, phí ship, trang SP top view** — Traffic cao nhưng conversion 0%, top SP 40k/33k view nhưng 0 đơn 28d
5. **Tạo KM mới thay cho KM vừa kết thúc và cân nhắc tham gia campaign nền tảng** — Giữ đà khuyến mãi và tăng hiển thị, hiện chưa tham gia campaign nào

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| homepage | ahr_score | 200 score | |
| homepage | violation_score | 0 score | |
| homepage | violation_total | 1 | |
| homepage | violation_critical | 1 | |
| homepage | violation_fulfillment | 0 | |
| homepage | has_new_violation | false | |
| homepage | to_settle_amount | 304.67 USD | |
| homepage | orders_total | 12 | |
| orders | action_ship_within_24h | 0 | |
| orders | action_auto_canceling_within_24h | 0 | |
| orders | action_shipping_overdue | 5 | |
| orders | action_cancellation_requested | 0 | |
| orders | action_logistics_issue | 0 | |
| orders | action_return_refund_requested | 0 | |
| orders | orders_to_ship | 6 | |
| orders | orders_shipped | 1 | |
| returns | return_respond_within_24h | 0 | |
| returns | return_auto_approved_7d | 0 | |
| returns | return_can_be_appealed | 0 | |
| returns | return_disputes_awaiting_response | 0 | |
| product-manage | products_total | 95 | |
| product-manage | products_no_views_28d | 0 | |
| product-manage | products_low_stock | 0 | |
| product-manage | products_out_of_stock | 0 | |
| product-manage | top_product_1 | Schoolgirl Costume Set Plaid Lace Trim 3 Piece Hal — 40898 views / 0 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | 2 Piece Lingerie Set Floral Lace Heart Detail Roma — 33027 views / 0 đơn (28d), tồn 37 | |
| product-manage | top_product_3 | Lace Lingerie Set Semi-Sheer Bow Decor Romantic Da — 22393 views / 2 đơn (28d), tồn 25 | |
| product-manage | top_product_4 | Lingerie set kawaii kitty embroidered lace-up wire — 18314 views / 0 đơn (28d), tồn 16 | |
| product-manage | top_product_5 | 2 Piece Lingerie Set Spaghetti Strap Backless Cris — 4291 views / 0 đơn (28d), tồn 61 | |
| shop-overview | revenue | 0 USD | |
| shop-overview | gross_revenue | 0 USD | |
| shop-overview | refund_amount | 0 USD | |
| shop-overview | orders | 0 | |
| shop-overview | items_sold | 0 | |
| shop-overview | page_views | 498 | |
| shop-overview | visitors | 419 | |
| shop-overview | video_revenue | 0 USD | |
| shop-overview | conversion_rate | 0 % | |
| shop-overview | period | 2026-07-10T00:00:00→2026-07-11T00:00:00 | |
| promotion | promotions_ongoing | 8 | |
| promotion | promotions_upcoming | 0 | |
| promotion | promotion_tools_enabled | 6 | |
| promotion | promotion_revenue_top_7d | 161.8 USD | |
| campaign | campaigns_joined | 0 | |
| campaign | campaigns_available | 0 | |
| campaign | campaigns_new_recommend | 0 | |
| messages | unread_violations | 0 | |
| messages | unread_appeals | 0 | |
| messages | unread_policies | 0 | |
| messages | unread_account_updates | 0 | |
| messages | unread_total | 10 | |
| messages | chat_unread | 0 | |
| messages | chat_queue | 0 | |
| messages | helpdesk_unread | 0 | |
| messages-account | unread_violations | 0 | |
| messages-account | unread_appeals | 0 | |
| messages-account | unread_policies | 0 | |
| messages-account | unread_account_updates | 0 | |
| messages-account | unread_total | 10 | |
| messages-account | msg_1 | [unread] Return/Refund Request Received — You have received a new return/refund request. You can find details in the TikTok Shop Sel | |
| messages-marketing | unread_violations | 0 | |
| messages-marketing | unread_appeals | 0 | |
| messages-marketing | unread_policies | 0 | |
| messages-marketing | unread_account_updates | 0 | |
| messages-marketing | unread_total | 8 | |
| messages-marketing | msg_1 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_2 | [unread] ✅ Know exactly what to do in your shop today! Your AI Homepage is ready — Check out your new homepage that is ready to help you set your priorities straight | |
