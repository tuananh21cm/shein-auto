# TikTok Shop — Overview 2026-07-09

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-09T23:06:43.968Z → 2026-07-09T23:13:15.499Z

Shop có 2 đơn quá hạn giao (shipping overdue) cần xử lý gấp và 2 tin chính sách chưa đọc. Doanh số hồi phục nhẹ với 1 đơn $21.05 sau ngày trước không có đơn.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | Không có vi phạm, không có khoản chờ quyết toán bất thường. |
| Vận hành | 🔴 Nghiêm trọng | 2 đơn quá hạn giao, 3 đơn chờ ship, 0 đơn đã ship hôm nay; 1 return tự động duyệt trong 7d. |
| Doanh số | 🟡 Cần chú ý | Revenue $21.05 (1 đơn), conversion 1.28%, 78 khách/91 lượt xem — vẫn thấp nhưng hồi phục từ 0 hôm qua. |
| Marketing | 🟡 Cần chú ý | 7 KM đang chạy, 6 chiến dịch khả dụng nhưng chưa tham gia; chưa dùng Follower Coupons; doanh thu KM 7d $127.22. |
| Sản phẩm | 🟡 Cần chú ý | 100 SP, không hết hàng/không SP 0 view; nhưng chỉ top_product_1 có đơn, 4 SP top view cao vẫn 0 đơn (28d). |
| Inbox | 🔴 Nghiêm trọng | 2 tin chính sách chưa đọc (guide review, partial refund CS), 30 tin chưa đọc tổng. |

## 📈 Xu hướng (vs hôm qua)
- ↑ **Doanh thu** — $0 → $21.05 (1 đơn) so hôm qua
- ↓ **Đơn quá hạn ship** — 3 → 2 đơn overdue
- ↑ **Lượt truy cập** — visitors 55 → 78, page_views 60 → 91
- ↑ **Conversion** — 0% → 1.28%

## ⚠️ Cảnh báo
- 🔴 **2 đơn giao hàng quá hạn** — action_shipping_overdue=2, orders_shipped hôm nay=0. Nguy cơ ảnh hưởng điểm sức khỏe (LSR/on-time) và bị phạt. → _Vào Orders lọc overdue, ship ngay hôm nay hoặc cập nhật tracking; nếu kho lỗi thì liên hệ vận chuyển và ghi chú lý do._
- 🔴 **2 tin chính sách chưa đọc** — Guide 'How to request reviews the right way' (review phải trung lập, tự nguyện) và 'CS partial refund cho aftersales'. Đây là quy định tuân thủ mới. → _Đọc ngay và điều chỉnh quy trình: không dụ/ép review, cập nhật kịch bản CS cho phép hoàn tiền một phần đúng chính sách để tránh vi phạm._
- 🟡 **1 return tự động duyệt trong 7d** — return_auto_approved_7d=1 — hoàn/trả bị duyệt tự động do không phản hồi kịp. → _Rà soát để không bỏ lỡ cửa sổ phản hồi 24h các return sau này._
- 🟢 **6 chiến dịch khả dụng chưa tham gia + chưa dùng Follower Coupons** — campaigns_available=6, campaigns_joined=0; marketing gợi ý Follower Coupons và các webinar/DFYD. → _Đánh giá và tham gia 1-2 campaign phù hợp danh mục shapewear/blouse; bật Follower Coupons để tăng chuyển đổi._

## 📋 Việc cần làm
1. **Xử lý 2 đơn quá hạn giao ngay (ship + nhập tracking)** — Tránh tụt điểm sức khỏe shop và bị phạt on-time
2. **Đọc 2 tin chính sách và cập nhật quy trình review + hoàn tiền một phần** — Tuân thủ quy định mới, tránh nguy cơ vi phạm/khóa shop
3. **Ship nốt 3 đơn to_ship còn lại trong hạn** — Giữ tỷ lệ giao đúng hạn khi đang có đơn dồn
4. **Tối ưu 4 SP top view nhưng 0 đơn (Ruched jumpsuit, Briefs, Deep v bodysuit...) — sửa giá/hình/khuyến mãi** — Lưu lượng cao nhưng không chuyển đổi, đang lãng phí traffic
5. **Bật Follower Coupons và cân nhắc tham gia 1-2 trong 6 campaign khả dụng** — Tăng chuyển đổi và mở rộng nguồn đơn (conversion mới 1.28%)

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `+0` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 2 | `-1 (-33%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 3 | `-1 (-25%)` |
| orders | orders_shipped | 0 | `-1 (-100%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 1 | `+1` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-opportunity | opportunities_tracked | 100 | `+0 (+0%)` |
| product-opportunity | opp_1 | Rhinestone Halter Top for Women — 3,455 searches / 1 sp (Women's Tanks & Camis) | |
| product-opportunity | opp_2 | Plus Size Ruffle Tunic Blouse — 3,445 searches / 1 sp (Blouses & Shirts) | |
| product-opportunity | opp_3 | Women's Square Neck Shapewear Bodysuit — 3,431 searches / 1 sp (Shapewear) | |
| product-opportunity | opp_4 | Plus Size Solid Color Button Shirt — 3,425 searches / 1 sp (Blouses & Shirts) | |
| product-opportunity | opp_5 | Dragonfly Graphic Baby Tee — 3,423 searches / 1 sp (Women's T-shirts) | |
| product-opportunity | opp_6 | Women's Seamless Breathable Knickers — 3,423 searches / 1 sp (Panties) | |
| product-opportunity | opp_7 | Silk Bow Lingerie Sleep Set — 3,420 searches / 1 sp (Lingerie) | |
| product-opportunity | opp_8 | Vintage Lucky Girl Graphic T-Shirt — 3,420 searches / 1 sp (Women's T-shirts) | |
| product-manage | products_total | 100 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | BLUELIFE Shapewear Shorts High Waist Tummy Control — 42337 views / 1 đơn (28d), tồn 39 | |
| product-manage | top_product_2 | BLUELIFE Ruched jumpsuit spaghetti strap bodycon s — 15903 views / 0 đơn (28d), tồn 262 | |
| product-manage | top_product_3 | BLUELIFE Shapewear Briefs High Waisted Knitted Str — 5115 views / 0 đơn (28d), tồn 55 | |
| product-manage | top_product_4 | BLUELIFE Deep v neck bodysuit stretchy sculpting b — 2613 views / 0 đơn (28d), tồn 424 | |
| product-manage | top_product_5 | BLUELIFE Shapewear bodysuit strapless anti-slip tu — 2548 views / 0 đơn (28d), tồn 32 | |
| shop-overview | revenue | 21.05 USD | `+21.05` |
| shop-overview | gross_revenue | 21.05 USD | `+21.05` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 1 | `+1` |
| shop-overview | items_sold | 1 | `+1` |
| shop-overview | page_views | 91 | `+31 (+52%)` |
| shop-overview | visitors | 78 | `+23 (+42%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 1.28 % | `+1.28` |
| shop-overview | period | 2026-07-08T00:00:00→2026-07-09T00:00:00 | |
| promotion | promotions_ongoing | 7 | `+2 (+40%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 6 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 127.22 USD | `+0 (+0%)` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 6 | `+1 (+20%)` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 2 | `-1 (-33%)` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 30 | `-4 (-12%)` |
| messages | msg_1 | [unread] New guide: How to request reviews the right way — Review requests must stay neutral, optional, and fair | |
| messages | msg_2 | [unread] Customer Service may now submit partial refund requests for eligible aftersales cases — Learn about the new way to resolve issues | |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 1 | `-1 (-50%)` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 28 | `-4 (-12%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 1 | `-1 (-50%)` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 28 | `-3 (-10%)` |
| messages-marketing | msg_1 | [unread] You haven’t used Follower Coupons yet — You haven’t used Follower Coupons yet | |
| messages-marketing | msg_2 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_3 | [unread] 🔥 3 Upcoming LIVE Training Webinars🚀 Learn and Grow — Drive Traffic, Handle Aftersale & Grow GMV — Save your seat for all 3 sessions! | |
| messages-marketing | msg_4 | [unread] ⏳Final hours of DFYD! Turn product photos into videos in seconds — AI video maker for DFYD | |
| messages-marketing | msg_5 | [unread] 🚀 [LIVE Showcase] $35K GMV Playbook for Deals For You Days 🦋 — Double your LIVE orders with proven seller tactics | |
| messages-marketing | msg_6 | [unread] 🎁 Scale High-Impact Visibility Through Auction-Driven Live Commerce — A sneaker seller scaled $30K from a single 8-hr LIVE AUCTION | |
| messages-marketing | msg_7 | [unread] 🎯 Fuel your DFYD sales with today's trending videos — Get inspired for DFYD | |
| messages-marketing | msg_8 | [unread] [TikTok Shop] Last Chance:  Registration for the 2026 Turning Up the Heat - Standard Registration is ending soon! — This is a friendly reminder that TikTok Shop invites you to participate in the  2026 Turni | |
