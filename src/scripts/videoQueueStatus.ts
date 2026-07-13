/**
 * Xem nhanh tiến độ queue Video Studio: đếm theo status, tốc độ các video
 * đã xong, video đang chạy ở step nào, lỗi gần nhất.
 * Usage: npx tsx src/scripts/videoQueueStatus.ts
 */
import { VideoDb } from "../state/videoDb";

const db = new VideoDb();
const st = db.db.prepare("SELECT status, COUNT(*) c FROM videos GROUP BY status").all() as any[];
console.log("Theo status:", st.map((r) => `${r.status}=${r.c}`).join("  "));

const done = db.db.prepare(
  "SELECT id, ROUND((updated_at-created_at)/1000.0) sec FROM videos WHERE status IN ('ready','posted') ORDER BY id DESC LIMIT 10"
).all() as any[];
if (done.length) {
  const avg = Math.round(done.reduce((a, r) => a + r.sec, 0) / done.length);
  console.log(`10 video xong gần nhất: TB ${avg}s/video —`, done.map((r) => `#${r.id}:${r.sec}s`).join(" "));
}

const cur = db.db.prepare("SELECT id, substr(title,1,40) t, step FROM videos WHERE status='generating'").all() as any[];
for (const r of cur) console.log(`Đang chạy: #${r.id} [${r.step}] ${r.t}`);

const err = db.db.prepare("SELECT id, step, substr(error,1,90) e FROM videos WHERE status='error' ORDER BY id DESC LIMIT 5").all() as any[];
for (const r of err) console.log(`Lỗi: #${r.id} [${r.step}] ${r.e}`);
db.close();
