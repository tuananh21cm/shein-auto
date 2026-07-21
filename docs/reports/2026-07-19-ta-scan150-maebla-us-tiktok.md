# TikTok Shop — Overview 2026-07-19

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-19T23:30:05.145Z → 2026-07-19T23:36:56.054Z

Shop có 8 đơn quá hạn giao kéo dài chưa xử lý và doanh thu giảm ~19% so hôm qua với conversion tụt mạnh. Sức khỏe & sản phẩm ổn nhưng vận hành và doanh số cần can thiệp gấp.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | AHR 200 điểm, không có vi phạm mới; còn 1 tin vi phạm chưa đọc cần rà soát |
| Vận hành | 🔴 Nghiêm trọng | 8 đơn shipping overdue (giữ nguyên từ hôm qua), 19 đơn chờ ship, chỉ 2 đơn đã giao; 5 return auto-approved 7d |
| Doanh số | 🟡 Cần chú ý | Revenue $74.93 (giảm ~19% từ $92.07), 2 đơn (giảm từ 4), conversion 1.27% (giảm từ 2.67%), refund $0 |
| Marketing | 🟢 Tốt | 5 promotion đang chạy (tăng 1), promo revenue 7d $597 (tăng từ $552); có tin 'promotion đã kết thúc' cần thay mới |
| Sản phẩm | 🟢 Tốt | 99 SP, 0 hết hàng/0 tồn thấp/0 không view; top view (bra ren) view cao nhưng ít đơn - cần tối ưu chuyển đổi |
| Inbox | 🟡 Cần chú ý | 59 tin chưa đọc, 1 tin vi phạm chưa đọc; có tin return/refund request và Account Health cần xử lý |

## 📈 Xu hướng (vs hôm qua)
- ↓ **Doanh thu** — $92.07 → $74.93 (-19%)
- ↓ **Đơn hàng** — 4 → 2 đơn
- ↓ **Tỷ lệ chuyển đổi** — 2.67% → 1.27% (-1.4đ)
- ↓ **Đơn đã giao** — 6 → 2 đơn/ngày
- ↑ **Promo revenue 7d** — $552 → $597

## ⚠️ Cảnh báo
- 🔴 **8 đơn quá hạn giao chưa xử lý** — action_shipping_overdue = 8, không đổi so hôm qua → nguy cơ auto-cancel, phạt trễ giao và tụt AHR. → _Ship ngay 8 đơn overdue hôm nay; nếu không thể giao, liên hệ khách/hủy đúng quy trình để tránh vi phạm on-time-shipping_
- 🔴 **1 tin vi phạm chưa đọc** — unread_violations = 1 tồn nhiều ngày; kèm tin Live Selling IPR Rules về tuân thủ bản quyền. → _Mở tin vi phạm ngay, đọc lý do, khắc phục và appeal trong hạn nếu có; rà soát nội dung LIVE/sản phẩm tránh IPR_
- 🟡 **Conversion & doanh thu giảm mạnh** — Traffic ổn (158 visitor) nhưng conversion rớt từ 2.67% xuống 1.27%. → _Kiểm tra giá/khuyến mãi, ảnh, review SP top-view; tạo promo thay cho chương trình vừa kết thúc_
- 🟡 **5 return auto-approved trong 7 ngày** — return_auto_approved_7d = 5, có tin return/refund request chưa đọc. → _Xem lý do hoàn để phát hiện lỗi SP/mô tả; phản hồi các yêu cầu return trong 24h_
- 🟢 **59 tin chưa đọc dồn ứ** — Nhiều tin marketing/training + tin quan trọng lẫn lộn. → _Dọn inbox, đọc tin Account Health Daily Report và giữ theo dõi tin chính sách/July Policy Update_

## 📋 Việc cần làm
1. **Xử lý ngay 8 đơn quá hạn giao (ship hoặc liên hệ khách/hủy đúng quy trình)** — Trễ giao kéo dài gây phạt, auto-cancel và giảm AHR
2. **Mở & xử lý tin vi phạm chưa đọc + rà soát tuân thủ IPR** — Vi phạm tồn đọng có thể dẫn tới phạt/khóa shop
3. **Ship 19 đơn to_ship còn lại trong hạn** — Tránh phát sinh thêm đơn overdue
4. **Tạo/điều chỉnh khuyến mãi thay chương trình đã kết thúc & tối ưu SP top-view ít đơn** — Khôi phục conversion và doanh thu vừa giảm 19%
5. **Phản hồi yêu cầu return/refund và phân tích 5 ca hoàn 7 ngày** — Giảm hoàn hàng, bảo vệ chỉ số dịch vụ
6. **Dọn inbox, đọc Account Health Daily Report** — Không bỏ sót cảnh báo chính sách quan trọng

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `+0` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 8 | `+0 (+0%)` |
| orders | action_cancellation_requested | 0 | `-1 (-100%)` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 19 | `-1 (-5%)` |
| orders | orders_shipped | 2 | `-4 (-67%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 5 | `+0 (+0%)` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 99 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | MEAUS Plus Size Wireless Bra Lace Floral Comfortab — 38223 views / 1 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | MEAUS Floral Lace Underwire Bra Delicate Romantic  — 35952 views / 0 đơn (28d), tồn 47 | |
| product-manage | top_product_3 | MEAUS Goth Lace Bralette Floral Underwire Triangle — 10752 views / 20 đơn (28d), tồn 881 | |
| product-manage | top_product_4 | MEAUS Lace Balconette Bra Sheer Underwire Backless — 6236 views / 4 đơn (28d), tồn 143 | |
| product-manage | top_product_5 | MEAUS Black Lace Push Up Bra Sheer Underwire Adjus — 5653 views / 3 đơn (28d), tồn 111 | |
| shop-overview | revenue | 74.93 USD | `-17.14 (-19%)` |
| shop-overview | gross_revenue | 75.04 USD | `-17.16 (-19%)` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 2 | `-2 (-50%)` |
| shop-overview | items_sold | 4 | `+0 (+0%)` |
| shop-overview | page_views | 211 | `+3 (+1%)` |
| shop-overview | visitors | 158 | `+8 (+5%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 1.27 % | `-1.4 (-52%)` |
| shop-overview | period | 2026-07-18T00:00:00→2026-07-19T00:00:00 | |
| promotion | promotions_ongoing | 5 | `+1 (+25%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 5 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 597.08 USD | `+44.81 (+8%)` |
| campaign | campaigns_available | 6 | `+0 (+0%)` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 1 | `+0 (+0%)` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 0 | `-1 (-100%)` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 59 | `-2 (-3%)` |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 1 | `+0 (+0%)` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `+0` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 59 | `+1 (+2%)` |
| messages-account | msg_1 | [unread] Return/Refund Request Received — You have received a new return/refund request. You can find details in the TikTok Shop Sel | |
| messages-account | msg_2 | [unread] Take Action Now: Review Your  Account Health Daily Report — Your Account Health Rating is currently at 200 points. | |
| messages-marketing | unread_violations | 1 | `+0 (+0%)` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `+0` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 57 | `+0 (+0%)` |
| messages-marketing | msg_1 | [unread] ⚡ Protect Your Shop: Live Selling IPR Rules You Need to Know — Stay compliant and avoid costly IPR violations on LIVE — Register now! | |
| messages-marketing | msg_2 | [unread] Don't Miss! 🔥 Get Your Extra Traffic & Subsidies 🚀 Learn and Grow — Learn how SKPP gives your products extra traffic and subsidies  — Register now! | |
| messages-marketing | msg_3 | [unread] 🔥 Master High-Converting Short Videos — Free Training Today — Learn the strategies behind videos that actually convert  — Register now! | |
| messages-marketing | msg_4 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_5 | [unread] 🔥 TODAY: Creator Growth Strategy + July Policy Update (2 Sessions) — Level up on creator content and stay compliant — Register now! | |
| messages-marketing | msg_6 | [unread] 🔥Scale your business with Fulfilled by TikTok — FBT enrollment invitation | |
| messages-marketing | msg_7 | [unread] 🎁 Scale High-Impact Visibility Through Auction-Driven Live Commerce — A sneaker seller scaled $30K from a single 8-hr LIVE AUCTION | |
| messages-marketing | msg_8 | [unread] 🔥 6 Upcoming Seller Training Webinars 🚀 Learn and Grow — Affiliate, Seller Video, Live Auction, Shop Tab  — Register now! | |
