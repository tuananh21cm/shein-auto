/** Kiểm tra map shop → Kiki profile + quota đăng hiện tại. */
import { publishStatus } from "../core/videoStudio/publishScheduler";
for (const s of publishStatus()) {
  console.log(`${s.shop}
   profile: ${s.profile ?? "❌ CHƯA MAP"}
   đã đăng 24h: ${s.postedToday}/${s.quota} · video ready: ${s.ready}
   đăng gần nhất: ${s.lastPostedAt ? new Date(s.lastPostedAt).toLocaleString("vi-VN") : "—"} · chờ thêm: ${s.minutesUntilNext}′`);
}
