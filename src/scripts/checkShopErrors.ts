/** Xem lỗi đăng gần nhất của 1 shop (chẩn đoán shop không publish được). */
import { VideoDb } from "../state/videoDb";

const q = (process.argv.find((a) => a.startsWith("--shop=")) ?? "--shop=").slice(7);
const db = new VideoDb();
const rows = db.db.prepare(
  "SELECT id, status, step, substr(error,1,140) e, substr(title,1,30) t FROM videos WHERE shop LIKE ? ORDER BY id DESC LIMIT 12"
).all(`%${q}%`) as any[];
for (const r of rows) console.log(`#${r.id} [${r.status}${r.step ? "/" + r.step : ""}] ${r.t}${r.e ? "\n     ⚠️ " + r.e : ""}`);
db.close();
