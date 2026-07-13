/** Liệt kê video ready theo shop (chọn video test publish). */
import { VideoDb } from "../state/videoDb";
const db = new VideoDb();
const rows = db.db.prepare(
  "SELECT id, shop, product_id, substr(title,1,45) t, status FROM videos WHERE status='ready' ORDER BY shop, id LIMIT 30"
).all() as any[];
for (const r of rows) console.log(`#${r.id} [${r.shop}] pid=${r.product_id} ${r.t}`);
console.log(`Tổng ready: ${rows.length}`);
db.close();
