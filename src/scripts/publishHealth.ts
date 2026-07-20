/** Sức khỏe auto-publish: video đăng theo ngày gần đây + trạng thái từng shop. */
import { VideoDb } from "../state/videoDb";
import { loadPublishState, inPostingWindow } from "../core/videoStudio/publishScheduler";

const db = new VideoDb();
const st = loadPublishState();
const now = Date.now();

console.log(`auto=${st.auto} · khung ${st.cfg.hourFrom}h→${st.cfg.hourTo}h · ${st.cfg.perShopPerDay}/shop/ngày`);
console.log(`Bây giờ (giờ máy) TRONG khung đăng? ${inPostingWindow(new Date(now), st.cfg) ? "CÓ" : "KHÔNG (ngoài giờ → cron nghỉ)"}`);

// Đếm posted theo từng ngày (7 ngày gần nhất) — dùng giờ máy
const rows = db.db.prepare(
  "SELECT posted_at FROM videos WHERE status='posted' AND posted_at IS NOT NULL AND posted_at >= ?"
).all(now - 8 * 86400_000) as any[];
const byDay: Record<string, number> = {};
for (const r of rows) {
  const d = new Date(r.posted_at);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  byDay[key] = (byDay[key] ?? 0) + 1;
}
console.log(`\nVideo đã đăng 7 ngày gần nhất:`);
for (const k of Object.keys(byDay).sort()) console.log(`   ${k}: ${byDay[k]}`);
if (!rows.length) console.log(`   (không có video nào đăng trong 8 ngày qua ⚠️)`);

// Đăng gần nhất toàn hệ thống
const last = db.db.prepare("SELECT MAX(posted_at) t FROM videos WHERE status='posted'").get() as any;
if (last?.t) {
  const hrs = Math.round((now - last.t) / 3600_000 * 10) / 10;
  console.log(`\nĐăng gần nhất: ${new Date(last.t).toLocaleString("vi-VN")} (${hrs}h trước)`);
}

const tot = db.db.prepare("SELECT status, COUNT(*) c FROM videos GROUP BY status").all() as any[];
console.log(`\nTồn kho: ${tot.map((r) => `${r.status}=${r.c}`).join("  ")}`);
db.close();
