# TikTok Shop — Overview 2026-07-20

> 🟡 **Tình trạng chung: Cần chú ý** · crawl partial · 2026-07-20T00:22:07.189Z → 2026-07-20T00:22:56.477Z

Dữ liệu hôm nay chỉ ở trạng thái một phần và chưa có chỉ số nào được ghi nhận, nên chưa thể đánh giá đầy đủ tình trạng shop. Cần đồng bộ lại dữ liệu trước khi kết luận.

## 📊 Sức khỏe theo mảng
| Mảng | Trạng thái | Nhận xét |
|---|---|---|
| Sức khỏe | 🟡 Cần chú ý | Không có dữ liệu ahr_score/vi phạm/tiền chờ quyết toán để đánh giá. |
| Vận hành | 🟡 Cần chú ý | Thiếu dữ liệu đơn cần ship/đã ship/hoàn hàng. |
| Doanh số | 🟡 Cần chú ý | Chưa có revenue/conversion/visitors hôm nay. |
| Marketing | 🟡 Cần chú ý | Không có dữ liệu khuyến mãi/chiến dịch. |
| Sản phẩm | 🟡 Cần chú ý | Thiếu dữ liệu tồn kho/SP không lượt xem/top sản phẩm. |
| Inbox | 🟡 Cần chú ý | Chưa có dữ liệu tin chưa đọc/chính sách/chat. |

## ⚠️ Cảnh báo
- 🟡 **Dữ liệu hôm nay chưa đầy đủ** — Trạng thái 'partial' và mảng metrics rỗng, không có chỉ số nào để phân tích. → _Kiểm tra kết nối API/đồng bộ Seller Center, tải lại dữ liệu và chạy lại báo cáo._
- 🟢 **Không có dữ liệu hôm qua để so sánh** — Mảng yesterday rỗng nên không thể tính xu hướng. → _Đảm bảo lưu snapshot dữ liệu hằng ngày để so sánh biến động._

## 📋 Việc cần làm
1. **Đồng bộ lại dữ liệu shop từ TikTok Seller Center** — Trạng thái partial và không có metrics khiến toàn bộ đánh giá không xác thực.
2. **Kiểm tra thủ công Sức khỏe shop (AHR, vi phạm, tin chính sách)** — Đây là mảng rủi ro cao nhất, cần xác nhận không có vi phạm/thông báo chính sách bị bỏ sót.
3. **Kiểm tra thủ công đơn cần ship trong 24h và đơn quá hạn** — Tránh trễ giao hàng làm giảm điểm vận hành khi dữ liệu tự động chưa có.
4. **Thiết lập lưu snapshot dữ liệu mỗi ngày** — Để có cơ sở so sánh xu hướng và phát hiện bất thường sớm.

## 📑 Chi tiết chỉ số
| Route | Chỉ số | Giá trị | Δ hôm qua |
|---|---|---|---|
