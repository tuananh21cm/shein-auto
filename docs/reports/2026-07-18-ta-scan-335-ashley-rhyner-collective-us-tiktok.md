# TikTok Shop — Overview 2026-07-18

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-18T23:42:11.590Z → 2026-07-18T23:49:11.633Z

Shop có 17 đơn quá hạn giao (tăng so hôm qua) và phát sinh sự cố logistics — cần xử lý gấp. Doanh số hôm nay giảm mạnh còn $46.15 với conversion chỉ 0.55%.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | Không có vi phạm, không có tin chính sách/vi phạm chưa đọc; sức khỏe shop ổn |
| Vận hành | 🔴 Nghiêm trọng | 17 đơn quá hạn giao (hôm qua 16), 1 sự cố logistics mới, 24 đơn chờ ship / mới ship 7 |
| Doanh số | 🟡 Cần chú ý | Doanh thu $46.15 giảm ~53% so $99.06; 2 đơn (hôm qua 4); conversion 0.55% (hôm qua 0.91%); refund $0 |
| Marketing | 🟢 Tốt | 6 KM đang chạy, 7 công cụ bật, doanh thu KM 7d $948.57; 6 chiến dịch có thể tham gia nhưng chưa join |
| Sản phẩm | 🟢 Tốt | 100 SP, không SP hết hàng/tồn thấp/0 view; top SP nhiều view (53k) nhưng đơn thấp (3) |
| Inbox | 🟢 Tốt | 0 tin vi phạm/chính sách chưa đọc; chỉ có thông báo return/refund và marketing; chat_queue 0 |

## 📈 Xu hướng (vs hôm qua)
- ↓ **Doanh thu** — $46.15 vs $99.06, giảm ~53%
- ↓ **Đơn hàng** — 2 đơn vs 4 đơn hôm qua
- ↓ **Conversion** — 0.55% vs 0.91%
- ↑ **Đơn quá hạn ship** — 17 vs 16 — đang tích tụ thêm
- ↓ **Lượt truy cập** — visitors 364 vs 440, page views 424 vs 541

## ⚠️ Cảnh báo
- 🔴 **17 đơn quá hạn giao hàng** — Số đơn quá hạn tăng từ 16 lên 17, ảnh hưởng trực tiếp điểm sức khỏe shop và tỷ lệ giao đúng hạn (LSR/OTD). → _Xử lý ngay toàn bộ 17 đơn overdue: xác nhận kho, tạo vận đơn và giao cho đơn vị vận chuyển trong hôm nay; đơn nào không giao được thì liên hệ khách/hủy đúng quy trình để tránh phạt._
- 🟡 **1 sự cố logistics mới phát sinh** — action_logistics_issue tăng từ 0 lên 1 — có đơn kẹt vận chuyển. → _Vào mục Logistics issue kiểm tra đơn bị lỗi, liên hệ hãng vận chuyển hoặc tạo lại vận đơn để tránh giao trễ/khiếu nại._
- 🟡 **Doanh số & conversion sụt giảm** — Doanh thu giảm ~53%, conversion 0.55% dù vẫn có 364 khách truy cập. → _Rà lại giá/khuyến mãi trên top SP nhiều view nhưng ít đơn; cân nhắc tham gia 1-2 campaign đang mở để kéo traffic chuyển đổi._
- 🟢 **1 yêu cầu return/refund** — Có thông báo Return/Refund Request Received chưa đọc. → _Mở tab Return, phản hồi trong 24h để tránh auto-approve bất lợi._

## 📋 Việc cần làm
1. **Giao/hủy 17 đơn quá hạn ship ngay trong hôm nay** — Đây là rủi ro phạt điểm sức khỏe cao nhất, số đang tăng dần
2. **Xử lý 1 sự cố logistics đang treo** — Ngăn đơn tiếp tục trễ và phát sinh khiếu nại
3. **Phản hồi yêu cầu return/refund trong 24h** — Tránh auto-approve hoàn tiền không mong muốn
4. **Ship nốt 24 đơn to-ship trước hạn, ưu tiên đơn cũ** — Ngăn đơn mới rơi vào nhóm overdue
5. **Tối ưu giá/KM cho top SP nhiều view ít đơn và cân nhắc join 1-2 trong 6 campaign đang mở** — Cải thiện conversion 0.55% và bù doanh thu đang giảm

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `-2 (-100%)` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 17 | `+1 (+6%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 1 | `+1` |
| orders | action_return_refund_requested | 1 | `+0 (+0%)` |
| orders | orders_to_ship | 24 | `+2 (+9%)` |
| orders | orders_shipped | 7 | `+1 (+17%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 6 | `+0 (+0%)` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 100 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | Lace Lingerie Set Eyelash Underwire Bra & Panty Ro — 53520 views / 3 đơn (28d), tồn 207 | |
| product-manage | top_product_2 | 2 Piece Lingerie Set Sheer Mesh Leaf Embroidery Un — 46614 views / 2 đơn (28d), tồn 223 | |
| product-manage | top_product_3 | 2 Piece Lingerie Set Sheer Lace Metallic Ribbon Ad — 37432 views / 1 đơn (28d), tồn 31 | |
| product-manage | top_product_4 | Matching Bra And Panty Set Floral Lace Underwire S — 33852 views / 0 đơn (28d), tồn 25 | |
| product-manage | top_product_5 | Lingerie Set Sexy Sheer Mesh Wireless Minimalist R — 31268 views / 1 đơn (28d), tồn 37 | |
| shop-overview | revenue | 46.15 USD | `-52.91 (-53%)` |
| shop-overview | gross_revenue | 46.16 USD | `-52.9 (-53%)` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 2 | `-2 (-50%)` |
| shop-overview | items_sold | 2 | `-2 (-50%)` |
| shop-overview | page_views | 424 | `-117 (-22%)` |
| shop-overview | visitors | 364 | `-76 (-17%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 0.55 % | `-0.36 (-40%)` |
| shop-overview | period | 2026-07-17T00:00:00→2026-07-18T00:00:00 | |
| promotion | promotions_ongoing | 6 | `+0 (+0%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 7 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 948.57 USD | `+0 (+0%)` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 6 | `+0 (+0%)` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 0 | `+0` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 14 | `+4 (+40%)` |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `+0` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 13 | `+3 (+30%)` |
| messages-account | msg_1 | [unread] Return/Refund Request Received — You have received a new return/refund request. You can find details in the TikTok Shop Sel | |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `+0` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 12 | `+2 (+20%)` |
| messages-marketing | msg_1 | [unread] You now have access to TikTok Shop's CRM tool 🎉 — Start using CRM to grow your shop | |
| messages-marketing | msg_2 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_3 | [unread] 🎁 Scale High-Impact Visibility Through Auction-Driven Live Commerce — A sneaker seller scaled $30K from a single 8-hr LIVE AUCTION | |
| messages-marketing | msg_4 | [unread] 📊 Voice of Customer Insights Page is Live — Understand Your Buyers, Improve Your Products | |
| messages-marketing | msg_5 | [unread] ACE Your Shop｜Powering Growth Across All Channels — The 2026 ACE Playbook empowers sellers to unlock sustainable growth on TikTok Shop by leve | |
| messages-marketing | msg_6 | [unread] 🔥You're In — Now Let's Make Your First Sale Happen! — Here's how to get your first sale | |
