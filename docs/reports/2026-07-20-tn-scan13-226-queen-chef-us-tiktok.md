# TikTok Shop — Overview 2026-07-20

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-20T00:23:13.291Z → 2026-07-20T00:30:18.204Z

Shop có 5 đơn quá hạn giao hàng — rủi ro AHR và phạt vận hành cao. Doanh số rất thấp (1 đơn, $4.91) và tỷ lệ chuyển đổi chỉ 1.27% dù có traffic.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟡 Cần chú ý | Không có vi phạm chưa đọc, nhưng 5 đơn quá hạn + 3 return tự duyệt (7d) sẽ kéo AHR xuống nếu tái diễn. |
| Vận hành | 🔴 Nghiêm trọng | 5 đơn shipping overdue, 8 đơn chờ ship / mới 1 đơn đã ship. Cần xử lý ngay để tránh auto-cancel & phạt. |
| Doanh số | 🟡 Cần chú ý | Doanh thu $4.91 (gross $21.63), 1 đơn / 1 SP bán, 79 khách - 97 lượt xem, refund $0. Conversion 1.27% thấp. |
| Marketing | 🟡 Cần chú ý | Mới tham gia 1/12 campaign; 1 promotion đã kết thúc cần gia hạn. Nhiều lời mời campaign hè 2026 chưa xử lý. |
| Sản phẩm | 🟢 Tốt | 97 SP, không có hàng hết/tồn thấp/0 view. Top SP swimsuit 11k view nhưng chỉ 1 đơn → cần tối ưu chuyển đổi. |
| Inbox | 🟡 Cần chú ý | 0 tin vi phạm/chính sách chưa đọc. Có 1 tin return/refund request và 1 alert 'promotion ended' cần theo dõi. |

## ⚠️ Cảnh báo
- 🔴 **5 đơn quá hạn giao hàng** — action_shipping_overdue = 5, có nguy cơ auto-cancel và tụt AHR/phạt vận hành. → _Ship ngay 5 đơn quá hạn + xử lý 8 đơn chờ ship trong hôm nay; upload tracking hợp lệ._
- 🟡 **3 return tự động được duyệt (7 ngày)** — return_auto_approved_7d = 3 do không phản hồi kịp — mất quyền kháng nghị và ảnh hưởng chỉ số dịch vụ. → _Thiết lập quy trình phản hồi return trong 24h; kiểm tra tin 'Return/Refund Request Received' trong hộp thư account._
- 🟡 **Promotion đã kết thúc** — Tin marketing báo 'Your promotion has ended' — mất đòn bẩy giá trong khi conversion đang thấp. → _Tạo/gia hạn promotion mới, cân nhắc tham gia thêm trong 12 campaign đang mở._
- 🟢 **Conversion thấp dù có traffic** — 79 visitor, 97 page view, chỉ 1 đơn (1.27%). Top SP 11k view chỉ 1 đơn. → _Rà soát giá, hình ảnh, review và mô tả các SP nhiều view ít đơn._

## 📋 Việc cần làm
1. **Giao ngay 5 đơn quá hạn + 8 đơn chờ ship, upload tracking hợp lệ** — Tránh auto-cancel, giữ AHR và tránh phạt vận hành
2. **Xây quy trình phản hồi return trong 24h** — Đã có 3 return auto-approved gây mất quyền kháng nghị
3. **Tạo/gia hạn promotion và xem xét tham gia thêm campaign** — Promotion vừa kết thúc, còn 11 campaign chưa tham gia — hỗ trợ tăng conversion
4. **Tối ưu listing các SP nhiều view - ít đơn (giá, ảnh, review)** — Conversion 1.27% quá thấp so với lượng traffic hiện có

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | |
| orders | action_auto_canceling_within_24h | 0 | |
| orders | action_shipping_overdue | 5 | |
| orders | action_cancellation_requested | 0 | |
| orders | action_logistics_issue | 0 | |
| orders | action_return_refund_requested | 0 | |
| orders | orders_to_ship | 8 | |
| orders | orders_shipped | 1 | |
| returns | return_respond_within_24h | 0 | |
| returns | return_auto_approved_7d | 3 | |
| returns | return_can_be_appealed | 0 | |
| returns | return_disputes_awaiting_response | 0 | |
| product-manage | products_total | 97 | |
| product-manage | products_no_views_28d | 0 | |
| product-manage | products_low_stock | 0 | |
| product-manage | products_out_of_stock | 0 | |
| product-manage | top_product_1 | American Flag One-Piece Swimsuit Star Striped Cuto — 11001 views / 1 đơn (28d), tồn 30 | |
| product-manage | top_product_2 | Tankini 2 Piece Set Polka Dot Print Camisole Top B — 6209 views / 2 đơn (28d), tồn 25 | |
| product-manage | top_product_3 | 2-Piece Bikini Set White Crochet Lace Triangle Hig — 3212 views / 2 đơn (28d), tồn 524 | |
| product-manage | top_product_4 | Bikini Set Contrast Sequin Floral Embroidered Bead — 2965 views / 2 đơn (28d), tồn 58 | |
| product-manage | top_product_5 | Ruched Bikini Set Leopard Print Spaghetti Strap Ti — 2614 views / 0 đơn (28d), tồn 70 | |
| shop-overview | revenue | 4.91 USD | |
| shop-overview | gross_revenue | 21.63 USD | |
| shop-overview | refund_amount | 0 USD | |
| shop-overview | orders | 1 | |
| shop-overview | items_sold | 1 | |
| shop-overview | page_views | 97 | |
| shop-overview | visitors | 79 | |
| shop-overview | video_revenue | 0 USD | |
| shop-overview | conversion_rate | 1.27 % | |
| shop-overview | period | 2026-07-18T00:00:00→2026-07-19T00:00:00 | |
| campaign | campaigns_joined | 1 | |
| campaign | campaigns_available | 12 | |
| campaign | campaigns_new_recommend | 0 | |
| messages | unread_violations | 0 | |
| messages | unread_appeals | 0 | |
| messages | unread_policies | 0 | |
| messages | unread_account_updates | 0 | |
| messages | unread_total | 19 | |
| messages | chat_unread | 0 | |
| messages | chat_queue | 0 | |
| messages | helpdesk_unread | 0 | |
| messages-account | unread_violations | 0 | |
| messages-account | unread_appeals | 0 | |
| messages-account | unread_policies | 0 | |
| messages-account | unread_account_updates | 0 | |
| messages-account | unread_total | 18 | |
| messages-account | msg_1 | [unread] Return/Refund Request Received — You have received a new return/refund request. You can find details in the TikTok Shop Sel | |
| messages-marketing | unread_violations | 0 | |
| messages-marketing | unread_appeals | 0 | |
| messages-marketing | unread_policies | 0 | |
| messages-marketing | unread_account_updates | 0 | |
| messages-marketing | unread_total | 15 | |
| messages-marketing | msg_1 | [unread] Accelerate your growth with these high-potential products — Discover trending products, keywords, and categories on TikTok Shop | |
| messages-marketing | msg_2 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_3 | [unread] [TikTok Shop] Join Now, register for the 2026 Summer Turn Up Campaign - Standard Registration! — Congratulations! We’re excited to share that you’ve been invited to participate in the 202 | |
| messages-marketing | msg_4 | [unread] 🎁 Scale High-Impact Visibility Through Auction-Driven Live Commerce — A sneaker seller scaled $30K from a single 8-hr LIVE AUCTION | |
| messages-marketing | msg_5 | [unread] 🚀 Wave 2 Is Live — Earn Up to $500 — 🚀 Wave 2 Is Live — Earn Up to $500 | |
| messages-marketing | msg_6 | [unread] ACE Your Shop｜Powering Growth Across All Channels — The 2026 ACE Playbook empowers sellers to unlock sustainable growth on TikTok Shop by leve | |
| messages-marketing | msg_7 | [unread] 🔥You're In — Now Let's Make Your First Sale Happen! — Here's how to get your first sale | |
