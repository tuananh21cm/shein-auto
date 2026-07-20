/** Lỗi đăng ở video CŨ NHẤT đang ready của shop (video scheduler thử trước). */
import { VideoDb } from "../state/videoDb";
const q = (process.argv.find((a) => a.startsWith("--shop=")) ?? "--shop=").slice(7);
const db = new VideoDb();
// video có error gần nhất + video ready cũ nhất
const err = db.db.prepare(
  "SELECT id, step, error FROM videos WHERE shop LIKE ? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
).get(`%${q}%`) as any;
const oldest = db.db.prepare(
  "SELECT id, step, error FROM videos WHERE shop LIKE ? AND status='ready' ORDER BY id LIMIT 1"
).get(`%${q}%`) as any;
console.log(`Lỗi gần nhất: ${err ? `#${err.id} [${err.step}] ${err.error}` : "(không có)"}`);
console.log(`Ready cũ nhất (sẽ thử trước): ${oldest ? `#${oldest.id} [${oldest.step}] ${oldest.error ?? "chưa có lỗi"}` : "(không)"}`);
db.close();
