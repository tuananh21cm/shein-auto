# TikTok Shop — Overview 2026-07-01

> 🔴 **Tình trạng chung: Nghiêm trọng** · crawl ok · 2026-07-01T23:24:58.737Z → 2026-07-01T23:28:07.426Z

Doanh số phục hồi mạnh hôm nay ($127.57 với 3 đơn sau ngày $0), vận hành sạch. Tuy nhiên vẫn tồn 1 vi phạm nghiêm trọng và 4 tin chính sách chưa đọc cần xử lý để tránh rủi ro khóa shop.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🔴 Nghiêm trọng | AHR 200 (tốt), violation_score 0 nhưng có 1 vi phạm CRITICAL chưa giải quyết; tồn thanh toán $106.43 |
| Vận hành | 🟢 Tốt | 0 đơn quá hạn/ship gấp, 3 đơn chờ ship + 2 đã ship, không có yêu cầu hoàn/trả |
| Doanh số | 🟢 Tốt | Revenue $127.57, 3 đơn, 5 SP bán, 0 refund; conversion 0.5% còn thấp |
| Marketing | 🟡 Cần chú ý | 7 KM đang chạy, 6 tool bật nhưng promotion_revenue 7d = $0; chưa tham gia campaign nào |
| Sản phẩm | 🟡 Cần chú ý | 62 SP, 10 SP không lượt xem 28d (tăng từ 3); top 5 SP đều 0 view/0 đơn |
| Inbox | 🔴 Nghiêm trọng | 4 tin chính sách chưa đọc (tracking, product safety appeal, refund, review) — rủi ro tuân thủ cao |

## 📈 Xu hướng (vs hôm qua)
- ↑ **Doanh thu** — $0 → $127.57 (từ 0 đơn lên 3 đơn)
- ↑ **Lượt truy cập** — visitors 188 → 605, page views 225 → 756
- ↑ **Conversion** — 0% → 0.5%
- ↑ **Số SP không view 28d** — 3 → 10 SP (xấu đi khi tăng SP tổng 49 → 62)
- ↑ **Tồn thanh toán** — $24.69 → $106.43

## ⚠️ Cảnh báo
- 🔴 **1 vi phạm nghiêm trọng chưa giải quyết** — violation_critical = 1 dù has_new_violation=false. Vi phạm critical có thể ảnh hưởng quyền bán/thanh toán. → _Vào Compliance Center xem chi tiết vi phạm, nộp appeal/khắc phục ngay theo hướng dẫn_
- 🔴 **4 tin chính sách chưa đọc — rủi ro tuân thủ** — Gồm: Strengthened Enforcement for Inaccurate Tracking Information, New Appeal Guidance for Product Safety, partial refund cho CS, cách request review đúng cách. Đây là các quy định enforcement mới. → _Đọc & áp dụng ngay: đảm bảo nhập tracking chính xác, rà soát an toàn sản phẩm, chuẩn hóa quy trình yêu cầu review (trung lập, tự nguyện)_
- 🟡 **Tracking chính xác bị siết chặt** — TikTok tăng cường xử phạt thông tin tracking sai/không cập nhật — 3 đơn đang chờ ship cần vào số tracking đúng. → _Ship và cập nhật tracking chính xác cho 3 đơn to_ship trong hạn_
- 🟢 **KM chưa tạo doanh thu** — 7 KM đang chạy nhưng promotion_revenue 7d = $0. → _Rà soát mức giảm/điều kiện KM, cân nhắc tham gia Deals For You Days 2026_

## 📋 Việc cần làm
1. **Xử lý vi phạm critical đang tồn (appeal hoặc khắc phục)** — Vi phạm nghiêm trọng đe dọa trực tiếp trạng thái shop và thanh toán
2. **Đọc 4 tin chính sách chưa đọc và áp dụng biện pháp tuân thủ** — Các enforcement mới (tracking, product safety, refund, review) có thể dẫn tới phạt nếu vi phạm
3. **Ship 3 đơn chờ + nhập tracking chính xác đúng hạn** — Chính sách siết tracking sai; tránh vi phạm fulfillment
4. **Tối ưu 10 SP không lượt xem 28d (ảnh + tiêu đề + tag), nhất là top 5 đều 0 view** — SP không hiển thị làm lãng phí tồn kho lớn (VD tồn 832) và kéo hiệu suất shop
5. **Rà soát 7 KM & cân nhắc tham gia Deals For You Days 2026** — KM chưa tạo doanh thu, cần điều chỉnh để tận dụng lượng truy cập đang tăng (605 visitors)
6. **Cải thiện conversion 0.5% qua giá/mô tả/đánh giá** — Traffic tốt nhưng tỷ lệ chuyển đổi thấp, còn dư địa tăng đơn

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| homepage | ahr_score | 200 score | `+0 (+0%)` |
| homepage | violation_score | 0 score | `+0` |
| homepage | violation_total | 1 | `+0 (+0%)` |
| homepage | violation_critical | 1 | `+0 (+0%)` |
| homepage | violation_fulfillment | 0 | `+0` |
| homepage | has_new_violation | false | |
| homepage | to_settle_amount | 106.43 USD | `+81.74 (+331%)` |
| homepage | orders_total | 3 | `+2 (+200%)` |
| orders | action_ship_within_24h | 0 | `+0` |
| orders | action_auto_canceling_within_24h | 0 | `+0` |
| orders | action_shipping_overdue | 0 | `+0` |
| orders | action_cancellation_requested | 0 | `+0` |
| orders | action_logistics_issue | 0 | `+0` |
| orders | action_return_refund_requested | 0 | `+0` |
| orders | orders_to_ship | 3 | `+2 (+200%)` |
| orders | orders_shipped | 2 | `+1 (+100%)` |
| returns | return_respond_within_24h | 0 | `+0` |
| returns | return_auto_approved_7d | 0 | `+0` |
| returns | return_can_be_appealed | 0 | `+0` |
| returns | return_disputes_awaiting_response | 0 | `+0` |
| product-manage | products_total | 62 | `+13 (+27%)` |
| product-manage | products_no_views_28d | 10 | `+7 (+233%)` |
| product-manage | products_low_stock | 0 | `+0` |
| product-manage | products_out_of_stock | 0 | `+0` |
| product-manage | top_product_1 | Lingerie Set Pink Floral Embroidered Sheer Mesh Un — 0 views / 0 đơn (28d), tồn 38 | |
| product-manage | top_product_2 | Corset Lingerie Set Sexy Underwire Thong Garter Da — 0 views / 0 đơn (28d), tồn 101 | |
| product-manage | top_product_3 | 2 Piece Lingerie Set Light Purple Sheer Lace Trim  — 0 views / 0 đơn (28d), tồn 296 | |
| product-manage | top_product_4 | 2 Piece Lingerie Set Eyelash Lace Leopard Print Pu — 0 views / 0 đơn (28d), tồn 30 | |
| product-manage | top_product_5 | 2 Piece Lingerie Set Embroidered Lace Sky Blue Adj — 0 views / 0 đơn (28d), tồn 832 | |
| shop-overview | revenue | 127.57 USD | `+127.57` |
| shop-overview | gross_revenue | 127.85 USD | `+127.85` |
| shop-overview | refund_amount | 0 USD | `+0` |
| shop-overview | orders | 3 | `+3` |
| shop-overview | items_sold | 5 | `+5` |
| shop-overview | page_views | 756 | `+531 (+236%)` |
| shop-overview | visitors | 605 | `+417 (+222%)` |
| shop-overview | video_revenue | 0 USD | `+0` |
| shop-overview | conversion_rate | 0.5 % | `+0.5` |
| shop-overview | period | 2026-06-30T00:00:00→2026-07-01T00:00:00 | |
| promotion | promotions_ongoing | 7 | `+1 (+17%)` |
| promotion | promotions_upcoming | 0 | `+0` |
| promotion | promotion_tools_enabled | 6 | `+1 (+20%)` |
| promotion | promotion_revenue_top_7d | 0 USD | `+0` |
| campaign | campaigns_joined | 0 | `+0` |
| campaign | campaigns_available | 0 | `+0` |
| campaign | campaigns_new_recommend | 0 | `+0` |
| messages | unread_violations | 0 | `+0` |
| messages | unread_appeals | 0 | `+0` |
| messages | unread_policies | 4 | `-2 (-33%)` |
| messages | unread_account_updates | 0 | `+0` |
| messages | unread_total | 15 | `-7 (-32%)` |
| messages | msg_1 | [unread] New guide: How to request reviews the right way — Review requests must stay neutral, optional, and fair | |
| messages | msg_2 | [unread] Customer Service may now submit partial refund requests for eligible aftersales cases — Learn about the new way to resolve issues | |
| messages | msg_3 | [unread] Get Ready for Deals For You Days 2026! — Check out Campaign Requirements on TikTok Shop Academy  | |
| messages | msg_4 | [unread] New Appeal Guidance for Product Safety Enforcements — Check out our policy update for the latest appeal requirements | |
| messages | msg_5 | [unread] Strengthened Enforcement for Inaccurate Tracking Information — What sellers need to do for accurate tracking | |
| messages | chat_unread | 0 | `+0` |
| messages | chat_queue | 0 | `+0` |
| messages | helpdesk_unread | 0 | `+0` |
| messages-account | unread_violations | 0 | `+0` |
| messages-account | unread_appeals | 0 | `+0` |
| messages-account | unread_policies | 4 | `-1 (-20%)` |
| messages-account | unread_account_updates | 0 | `+0` |
| messages-account | unread_total | 14 | `-6 (-30%)` |
| messages-marketing | unread_violations | 0 | `+0` |
| messages-marketing | unread_appeals | 0 | `+0` |
| messages-marketing | unread_policies | 4 | `-1 (-20%)` |
| messages-marketing | unread_account_updates | 0 | `+0` |
| messages-marketing | unread_total | 14 | `-6 (-30%)` |
| messages-marketing | msg_1 | [unread] 🔥You're In — Now Let's Make Your First Sale Happen! — Here's how to get your first sale | |
| messages-marketing | msg_2 | [unread] ACE Your Shop｜Powering Growth Across Discovery Channels — The 2026 ACE Playbook provides sellers with a strategic and actionable framework to drive  | |
| messages-marketing | msg_3 | [unread] Join the Product Innovation Webinar: What’s new on TikTok Shop — New tools to help you sell smarter | |
