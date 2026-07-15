/** Verify map shop → Kiki profile cho danh sách shop truyền qua --shops (chuỗi con). */
import { EditDb } from "../services/tiktok/editDb";

const q = (process.argv.find((a) => a.startsWith("--shops=")) ?? "--shops=")
  .slice(8).split(",").map((s) => s.trim()).filter(Boolean);

const db = new EditDb();
const all = db.allProfiles();
for (const f of q) {
  const hit = all.find((p) => p.shop.toLowerCase().includes(f.toLowerCase()));
  console.log(`${f.padEnd(18)} → ${hit ? `${hit.shop}  [${hit.kiki_profile}]` : "CHƯA MAP"}`);
}
db.close();
