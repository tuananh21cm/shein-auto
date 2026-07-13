/** Đưa video kẹt ở generating (tiến trình render đã chết) trở lại queue. */
import { VideoDb } from "../state/videoDb";

const db = new VideoDb();
const stuck = db.db.prepare("SELECT id, shop, step FROM videos WHERE status='generating'").all() as any[];
for (const s of stuck) {
  db.setStatus(s.id, { status: "queued", error: null });
  console.log(`↩️  #${s.id} [${s.step}] ${s.shop} → queued`);
}
console.log(`\nĐã đưa ${stuck.length} video về queue. Server (cron 5′) sẽ tự render tuần tự.`);
const c = db.db.prepare("SELECT status, COUNT(*) c FROM videos GROUP BY status").all() as any[];
console.log(c.map((r) => `${r.status}=${r.c}`).join("  "));
db.close();
