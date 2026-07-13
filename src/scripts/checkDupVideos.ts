/** Kiểm tra video render trùng (2 tiến trình cùng nhặt 1 video) + đang generating. */
import { VideoDb } from "../state/videoDb";

const db = new VideoDb();
const dup = db.db.prepare(
  "SELECT product_id, COUNT(*) c FROM videos WHERE status IN ('ready','posted','generating') GROUP BY product_id HAVING c > 1"
).all() as any[];
console.log(`Sản phẩm có >1 video: ${dup.length}`);
for (const d of dup.slice(0, 8)) console.log(`  pid=${d.product_id} x${d.c}`);

const gen = db.db.prepare("SELECT id, shop, step FROM videos WHERE status='generating'").all() as any[];
console.log(`\nĐang generating: ${gen.length}`);
for (const g of gen) console.log(`  #${g.id} [${g.step}] ${g.shop}`);
db.close();
