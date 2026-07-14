# TikTok Shop — Overview 2026-06-27

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-06-27T23:41:52.900Z → 2026-06-27T23:47:54.980Z

Có 2 đơn quá hạn ship cần xử lý ngay và 14 thông báo chính sách chưa đọc (gồm nhiều cập nhật ảnh hưởng tuân thủ). Doanh số đứng yên với 0 đơn và traffic rất thấp (14 khách).

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | Không có vi phạm/kháng cáo; chưa thấy AHR cảnh báo. |
| Vận hành | 🔴 Nghiêm trọng | 2 đơn shipping_overdue chưa ship, 0 đơn shipped — nguy cơ phạt SLA & auto-cancel. |
| Doanh số | 🟡 Cần chú ý | Revenue $0, 0 đơn; traffic giảm còn 14 khách / 16 page views, conversion 0%. |
| Marketing | 🟡 Cần chú ý | 5 KM đang chạy (giảm 1 so hôm qua), promo revenue 7d $207.33; chưa join campaign nào. |
| Sản phẩm | 🟢 Tốt | 67 SP, không có hết hàng/tồn thấp/0 view; top SP Mexico Print 20.206 view/9 đơn. |
| Inbox | 🔴 Nghiêm trọng | 14 tin chính sách chưa đọc (Connected Accounts, Buyer Info, Size/Material...) cần xử lý tuân thủ. |

## 📈 Xu hướng (vs hôm qua)
- ↓ **Visitors** — 17 → 14 khách (-18%)
- ↓ **Page views** — 26 → 16 (-38%)
- ↓ **Đơn cần ship** — 4 → 2 (đã giải quyết bớt nhưng 2 vẫn quá hạn)
- ↓ **Khuyến mãi đang chạy** — 6 → 5 (1 promo đã kết thúc)

## ⚠️ Cảnh báo
- 🔴 **2 đơn quá hạn giao hàng** — action_shipping_overdue = 2, orders_shipped = 0. Đơn tồn từ hôm qua chưa được ship, rủi ro vi phạm SLA và bị auto-cancel/phạt AHR. → _Vào Orders xử lý ship ngay 2 đơn này hôm nay, tạo vận đơn và cập nhật tracking._
- 🔴 **Cập nhật chính sách Connected Accounts** — Thông báo 'Connected Accounts: What to Know' — thiết bị/địa chỉ/đa-shop dùng chung có thể ảnh hưởng đánh giá liên kết tài khoản, rủi ro khóa shop. → _Đọc kỹ, đảm bảo không dùng chung thiết bị/IP/địa chỉ với shop khác; rà soát đăng nhập._
- 🔴 **Yêu cầu thông tin người mua & liên hệ ngoài nền tảng** — 'Buyer Information and Customer Communication Requirements' — chỉ dùng thông tin buyer cho fulfillment/after-sales, cấm liên hệ off-platform. → _Không nhắn tin/liên hệ khách ngoài TikTok; xóa quy trình thu thập data buyer ngoài mục đích đơn hàng._
- 🟡 **Rà soát Size & Material trong listing** — TikTok yêu cầu thông tin size/chất liệu nhất quán giữa các phần của listing, tránh phạt sai lệch mô tả. → _Kiểm tra 67 SP, đồng bộ size/material ở tiêu đề, mô tả và thuộc tính._
- 🟡 **14 tin chính sách chưa đọc** — Gồm Final Sale/buyer protection, Delivery SLA extension, partial refund mới, hướng dẫn xin review đúng cách. → _Đọc hết tab Policies hôm nay, ghi chú các thay đổi áp dụng cho shop._

## 📋 Việc cần làm
1. **Ship ngay 2 đơn quá hạn, tạo tracking** — Tránh phạt SLA, auto-cancel và tụt AHR
2. **Đọc & tuân thủ tin Connected Accounts và Buyer Communication** — Rủi ro khóa/đánh dấu liên kết tài khoản nếu vi phạm
3. **Rà soát size/material toàn bộ listing cho nhất quán** — Tránh phạt mô tả sai và tăng tỷ lệ chuyển đổi
4. **Xử lý hết 14 tin chính sách chưa đọc** — Nắm thay đổi Final Sale, SLA, partial refund để vận hành đúng
5. **Khắc phục traffic giảm: bật/đẩy promo, cân nhắc join campaign 'Turning Up the Heat'** — Visitors -18%, conversion 0%, doanh thu $0 nhiều ngày
6. **Tối ưu 4 SP top-view nhưng 0 đơn (Striped, Sleeveless, 4-pack, White Tank)** — Có lượng view tốt nhưng không ra đơn — cải thiện giá/ảnh/mô tả để chuyển đổi

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `+0` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 2 | `+0 (+0%)` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 2 | `-2 (-50%)` |
| orders | orders_shipped | 0 | `+0` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 0 | `+0` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 67 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | AESS 2 In 1 Halter Camisole Tube Top Mexico Print  — 20206 views / 9 đơn (28d), tồn 658 | |
| product-manage | top_product_2 | AESS Camisole Top Striped Print Slim Fit Sexy Ling — 1568 views / 0 đơn (28d), tồn 919 | |
| product-manage | top_product_3 | AESS Sleeveless crop top solid minimalist casual s — 1529 views / 0 đơn (28d), tồn 898 | |
| product-manage | top_product_4 | AESS 4 pack camisole tank tops slim fit stretchy s — 1021 views / 0 đơn (28d), tồn 883 | |
| product-manage | top_product_5 | AESS White Tank Top Slim Fit Halter Neck Summer Ev — 944 views / 0 đơn (28d), tồn 473 | |
| shop-overview | revenue | 0 USD | `+0` |
| shop-overview | gross_revenue | 0 USD | `+0` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 0 | `+0` |
| shop-overview | items_sold | 0 | `+0` |
| shop-overview | page_views | 16 | `-10 (-38%)` |
| shop-overview | visitors | 14 | `-3 (-18%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 0 % | `+0` |
| shop-overview | period | 2026-06-26T00:00:00→2026-06-27T00:00:00 | |
| promotion | promotions_ongoing | 5 | `-1 (-17%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 6 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 207.33 USD | `+0 (+0%)` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 0 | `+0` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 14 | `+0 (+0%)` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 58 | `-3 (-5%)` |
| messages | msg_1 | [unread] 🔥 8 Upcoming Seller Training Webinars 🚀 Learn and Get Ready for Deals For You Days. — Campaign, Live Auction, Seller Video  — Register now! | |
| messages | msg_2 | [unread] 📣 Updates to Final Sale and buyer protections for Live Auction, Collectibles, and Pre-owned items — Click to see what's changing | |
| messages | msg_3 | [unread] Connected Accounts: What to Know — Shared devices, addresses, or multi-shop operations may affect connected account assessmen | |
| messages | msg_4 | [unread] Delivery SLA Extension in Select Cities — One additional day for cities hosting FIFA World Cup tournaments | |
| messages | msg_5 | [unread] Review Size and Material Information in Product Listings — Ensure size and material details are consistent across all sections of your product listin | |
| messages | msg_6 | [unread] Customer Service may now submit partial refund requests for eligible aftersales cases — Learn about the new way to resolve issues | |
| messages | msg_7 | [unread] Buyer Information and Customer Communication Requirements — Buyer information may only be used for order fulfillment and after-sales services. Off-pla | |
| messages | msg_8 | [unread] New guide: How to request reviews the right way — Review requests must stay neutral, optional, and fair | |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 13 | `-1 (-7%)` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 56 | `-4 (-7%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 13 | `-1 (-7%)` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 55 | `-4 (-7%)` |
| messages-marketing | msg_1 | [unread] 🚀 [LIVE Showcase] $35K GMV Playbook for Deals For You Days 🦋 — Double your LIVE orders with proven seller tactics | |
| messages-marketing | msg_2 | [unread] 🔥You're In — Now Let's Make Your First Sale Happen! — Here's how to get your first sale | |
| messages-marketing | msg_3 | [unread] 🚀 Boost Your GMV: Join June Turning Up the Heat Campaign! — Unlock exclusive campaign tags and extra marketing support to skyrocket your sales | |
| messages-marketing | msg_4 | [unread] Essential Checklist for Deals For You Days — Recommended Actions before and during the Biggest Campaign of the season. | |
| messages-marketing | msg_5 | [unread] [TikTok Shop] Last Chance:  Registration for the 2026 Turning Up the Heat - Standard Registration is ending soon! — This is a friendly reminder that TikTok Shop invites you to participate in the  2026 Turni | |
| messages-marketing | msg_6 | [unread] Accelerate your growth with these high-potential products — Discover trending products, keywords, and categories on TikTok Shop | |
| messages-marketing | msg_7 | [unread] 🔥 5 Upcoming Seller Training Webinars 🚀 Learn and Grow — Campaign, Live Auction, Seller Video  — Register now! | |
| messages-marketing | msg_8 | [unread] ACE Your Shop｜Powering Growth Across Discovery Channels — The 2026 ACE Playbook provides sellers with a strategic and actionable framework to drive  | |
