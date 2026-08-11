/** Kiểm tra map shop → Kiki profile + quota đăng hiện tại. */
import { publishStatus, loadPublishState } from "../core/videoStudio/publishScheduler";
// Dùng cfg ĐANG CHẠY (data/video-publish.json), không phải DEFAULT_SCHEDULER —
// nếu không quota/giãn cách hiển thị lệch với cái cron thực sự áp dụng.
for (const s of publishStatus(loadPublishState().cfg)) {
  console.log(`${s.shop}
   profile: ${s.profile ?? "❌ CHƯA MAP"}
   đã đăng 24h: ${s.postedToday}/${s.quota} · video ready: ${s.ready}
   đăng gần nhất: ${s.lastPostedAt ? new Date(s.lastPostedAt).toLocaleString("vi-VN") : "—"} · chờ thêm: ${s.minutesUntilNext}′`);
}
