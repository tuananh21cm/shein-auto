# TikTok Shop — Overview 2026-07-19

> 🟡 **Tình trạng chung: Cần chú ý** · crawl partial · 2026-07-19T23:26:01.607Z → 2026-07-19T23:29:49.940Z

Dữ liệu hôm nay chỉ có phần Vận hành. Không có đơn quá hạn ship, nhưng còn 10 đơn chờ giao cần xử lý sớm; các mảng khác thiếu dữ liệu để đánh giá.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟢 Tốt | Không có dữ liệu vi phạm/AHR hôm nay — chưa phát hiện rủi ro. |
| Vận hành | 🟡 Cần chú ý | 10 đơn chờ giao, mới ship 2. Không có đơn quá hạn/hủy/hoàn — cần đẩy nhanh 10 đơn còn lại. |
| Doanh số | 🟢 Tốt | Không có dữ liệu doanh thu/chuyển đổi hôm nay. |
| Marketing | 🟢 Tốt | Không có dữ liệu khuyến mãi/chiến dịch hôm nay. |
| Sản phẩm | 🟢 Tốt | Không có dữ liệu sản phẩm/tồn kho hôm nay. |
| Inbox | 🟢 Tốt | Không có tin chưa đọc/thông báo chính sách hôm nay. |

## ⚠️ Cảnh báo
- 🟡 **10 đơn chờ giao chưa xử lý** — Có 10 đơn ở trạng thái chờ giao, mới ship 2. Chưa quá hạn nhưng tồn đọng dễ dẫn tới trễ ship nếu để lâu. → _Đóng gói và tạo vận đơn cho 10 đơn còn lại trong hôm nay để tránh rơi vào trạng thái overdue._
- 🟢 **Dữ liệu không đầy đủ** — Chỉ có chỉ số Vận hành; thiếu Sức khỏe, Doanh số, Marketing, Sản phẩm, Inbox. → _Kiểm tra lại nguồn dữ liệu/đồng bộ dashboard để có bức tranh đầy đủ._

## 📋 Việc cần làm
1. **Xử lý và ship 10 đơn đang chờ giao** — Ngăn đơn chuyển sang trạng thái quá hạn, bảo vệ chỉ số on-time shipping.
2. **Đồng bộ/kiểm tra dữ liệu các mảng còn thiếu** — Đảm bảo theo dõi đầy đủ sức khỏe shop, doanh số và chính sách.

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
| orders | action_ship_within_24h | 0 | |
| orders | action_auto_canceling_within_24h | 0 | |
| orders | action_shipping_overdue | 0 | |
| orders | action_cancellation_requested | 0 | |
| orders | action_logistics_issue | 0 | |
| orders | action_return_refund_requested | 0 | |
| orders | orders_to_ship | 10 | |
| orders | orders_shipped | 2 | |
