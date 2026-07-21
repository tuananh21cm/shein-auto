# TikTok Shop — Overview 2026-07-18

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl partial · 2026-07-18T23:16:50.634Z → 2026-07-18T23:23:45.876Z

Shop có 8 đơn quá hạn giao và 1 tin vi phạm + 1 tin chính sách chưa đọc. Doanh thu giảm mạnh còn $92 (~-52% so hôm qua), conversion tụt còn 2.67%.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟡 Cần chú ý | AHR 200 điểm (báo cáo daily chưa đọc), 1 tin vi phạm chưa mở — cần kiểm tra để tránh trừ điểm thêm |
| Vận hành | 🔴 Nghiêm trọng | 8 đơn quá hạn giao (giữ nguyên từ hôm qua chưa xử lý), 20 đơn chờ ship nhưng chỉ 6 đã ship (hôm qua 12), 1 yêu cầu hủy |
| Doanh số | 🟡 Cần chú ý | Revenue $92.07 (-52% vs $193.47), đơn 4 (-50%), conversion 2.67% (-2.43đ), refund $0 |
| Marketing | 🟡 Cần chú ý | Promotions còn 4 (giảm 1), 1 promotion đã kết thúc chưa gia hạn; promo revenue 7d $552 (+14%) |
| Sản phẩm | 🟢 Tốt | 99 SP, 0 hết hàng / 0 tồn thấp / 0 SP không view; top SP #2 Goth Lace Bralette 20 đơn tồn 882 |
| Inbox | 🔴 Nghiêm trọng | 1 tin vi phạm + 1 tin chính sách chưa đọc; tổng 61 chưa đọc; có tin Return/Refund và AHR daily report cần xử lý |

## 📈 Xu hướng (vs hôm qua)
- ↓ **Doanh thu** — $92.07 vs $193.47 hôm qua (-52%)
- ↓ **Đơn hàng** — 4 đơn vs 8 hôm qua (-50%)
- ↓ **Conversion** — 2.67% vs 5.10% hôm qua (-2.43 điểm)
- ↓ **Đơn đã ship** — 6 vs 12 hôm qua — tiến độ giao chậm lại
- ↑ **Promo revenue 7d** — $552.27 vs $483.70 (+14%)

## ⚠️ Cảnh báo
- 🔴 **8 đơn quá hạn giao chưa xử lý** — action_shipping_overdue=8, giữ nguyên từ hôm qua; ảnh hưởng trực tiếp AHR và có thể bị phạt/hủy đơn tự động → _Ship ngay 8 đơn overdue trong hôm nay, cập nhật tracking; nếu thiếu hàng liên hệ buyer để tránh chargeback_
- 🔴 **1 tin vi phạm chưa đọc** — unread_violations=1 trên cả 3 hộp thư — chưa mở nên chưa rõ nội dung/deadline kháng nghị → _Mở ngay tin vi phạm, đọc lý do và hạn appeal; nếu có quyền kháng nghị thì chuẩn bị bằng chứng nộp trước hạn_
- 🔴 **Tin chính sách + AHR daily report chưa đọc** — unread_policies=1 và tin 'Review Your Account Health Daily Report - AHR 200 points' chưa mở → _Đọc báo cáo AHR, xác định chỉ số nào kéo điểm (nhiều khả năng do late shipment) và khắc phục để giữ điểm_
- 🟡 **Yêu cầu hủy đơn mới** — action_cancellation_requested=1 → _Xử lý yêu cầu hủy trong 24h để tránh tranh chấp và ảnh hưởng chỉ số_
- 🟡 **Conversion & doanh thu giảm sâu** — Conversion 2.67% (nửa hôm qua), doanh thu -52% dù traffic gần tương đương (150 vs 157 visitors) → _Kiểm tra promotion vừa kết thúc, gia hạn/kích hoạt lại flash sale, rà giá top SP_
- 🟢 **1 promotion đã kết thúc** — Tin 'Your promotion has ended'; promotions_ongoing giảm từ 5 xuống 4 → _Tạo/gia hạn promotion thay thế để bù conversion_

## 📋 Việc cần làm
1. **Xử lý & ship 8 đơn quá hạn giao ngay trong hôm nay** — Giữ nguyên từ hôm qua, đe dọa AHR và có thể bị hủy đơn/phạt tự động
2. **Mở đọc tin vi phạm và kiểm tra hạn kháng nghị** — Vi phạm chưa xử lý có thể leo thang thành phạt/khóa gian hàng
3. **Đọc AHR Daily Report (200 điểm) và tin chính sách** — Nắm chỉ số nào đang kéo điểm để khắc phục kịp thời
4. **Duyệt yêu cầu hủy đơn (1) trong 24h** — Tránh tranh chấp và ảnh hưởng chỉ số vận hành
5. **Gia hạn/tạo lại promotion đã kết thúc + rà giá top SP** — Hồi phục conversion và doanh thu vừa giảm 52%
6. **Đẩy top SP #2 (Goth Lace Bralette, 20 đơn, tồn 882) qua video/campaign** — Sản phẩm bán chạy còn nhiều tồn, tận dụng để bù doanh thu

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | `-2 (-100%)` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 8 | `+0 (+0%)` |
| orders | action_cancellation_requested | 1 | `+1` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 20 | `+0 (+0%)` |
| orders | orders_shipped | 6 | `-6 (-50%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 5 | `+0 (+0%)` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 99 | `+0 (+0%)` |
| product-manage | products_no_views_28d | 0 | `+0` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | MEAUS Plus Size Wireless Bra Lace Floral Comfortab — 38165 views / 1 đơn (28d), tồn 35 | |
| product-manage | top_product_2 | MEAUS Goth Lace Bralette Floral Underwire Triangle — 10410 views / 20 đơn (28d), tồn 882 | |
| product-manage | top_product_3 | MEAUS Lace Balconette Bra Sheer Underwire Backless — 6159 views / 4 đơn (28d), tồn 142 | |
| product-manage | top_product_4 | MEAUS Black Lace Push Up Bra Sheer Underwire Adjus — 5323 views / 3 đơn (28d), tồn 111 | |
| product-manage | top_product_5 | MEAUS Goth Lace Bralette Floral Underwire Triangle — 3466 views / 8 đơn (28d), tồn 870 | |
| shop-overview | revenue | 92.07 USD | `-101.4 (-52%)` |
| shop-overview | gross_revenue | 92.2 USD | `-101.27 (-52%)` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 4 | `-4 (-50%)` |
| shop-overview | items_sold | 4 | `-5 (-56%)` |
| shop-overview | page_views | 208 | `-29 (-12%)` |
| shop-overview | visitors | 150 | `-7 (-4%)` |
| shop-overview | review_cnt | 1 | |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 2.67 % | `-2.43 (-48%)` |
| shop-overview | period | 2026-07-17T00:00:00→2026-07-18T00:00:00 | |
| promotion | promotions_ongoing | 4 | `-1 (-20%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 5 | `+0 (+0%)` |
| promotion | promotion_revenue_top_7d | 552.27 USD | `+68.57 (+14%)` |
| campaign | campaigns_available | 6 | `+0 (+0%)` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 1 | `+0 (+0%)` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 1 | `+0 (+0%)` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 61 | `-3 (-5%)` |
| messages | msg_1 | [unread] New Seller IM cancellation option for auction orders — Click to learn about what's changing | |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 1 | `+0 (+0%)` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 0 | `-1 (-100%)` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 58 | `-4 (-6%)` |
| messages-account | msg_1 | [unread] Return/Refund Request Received — You have received a new return/refund request. You can find details in the TikTok Shop Sel | |
| messages-account | msg_2 | [unread] Take Action Now: Review Your  Account Health Daily Report — Your Account Health Rating is currently at 200 points. | |
| messages-marketing | unread_violations | 1 | `+0 (+0%)` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 0 | `-1 (-100%)` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 57 | `-4 (-7%)` |
| messages-marketing | msg_1 | [unread] You now have access to TikTok Shop's CRM tool 🎉 — Start using CRM to grow your shop | |
| messages-marketing | msg_2 | [unread] Don't Miss! 🔥 Get Your Extra Traffic & Subsidies 🚀 Learn and Grow — Learn how SKPP gives your products extra traffic and subsidies  — Register now! | |
| messages-marketing | msg_3 | [unread] 🔥 Master High-Converting Short Videos — Free Training Today — Learn the strategies behind videos that actually convert  — Register now! | |
| messages-marketing | msg_4 | [unread] Optimization Alert: Your promotion has ended — Optimization Alert: Your promotion has ended | |
| messages-marketing | msg_5 | [unread] 🔥 TODAY: Creator Growth Strategy + July Policy Update (2 Sessions) — Level up on creator content and stay compliant — Register now! | |
| messages-marketing | msg_6 | [unread] 🔥Scale your business with Fulfilled by TikTok — FBT enrollment invitation | |
| messages-marketing | msg_7 | [unread] 🎁 Scale High-Impact Visibility Through Auction-Driven Live Commerce — A sneaker seller scaled $30K from a single 8-hr LIVE AUCTION | |
| messages-marketing | msg_8 | [unread] 🔥 6 Upcoming Seller Training Webinars 🚀 Learn and Grow — Affiliate, Seller Video, Live Auction, Shop Tab  — Register now! | |
