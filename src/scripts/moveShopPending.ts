/**
 * moveShopPending — chuyển listing PENDING (file JSON ở gốc folder) từ shop nguồn (lỗi)
 * sang shop đích, + gán ngách cho shop đích. MOVE (xoá khỏi nguồn) vì shop nguồn bị bỏ.
 * Dry-run mặc định; --apply để thực thi.
 *   npx tsx src/scripts/moveShopPending.ts [--apply]
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const base = process.env.BASE_SHEINAUTO_DIR || "C:/Users/KBT/Downloads/SheinAuto";

const SRC = "TN Scan44-Bawse Accessories & Design_US";
const DST = "TA Scan 335-Ashley Rhyner Collective_US";
const NICHE = "underwear-sets"; // ngách của shop nguồn → gán cho shop đích

const log = (m: string) => console.log(m);
log(apply ? "▶️ APPLY\n" : "🔍 DRY-RUN (thêm --apply để chạy thật)\n");

const srcDir = path.join(base, SRC);
const dstDir = path.join(base, DST);
const pendings = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith(".json"))
  : [];

log(`[PENDING] ${pendings.length} file JSON: ${SRC}  →  ${DST}`);
if (apply) {
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  let moved = 0, skipped = 0;
  for (const f of pendings) {
    const dest = path.join(dstDir, f);
    if (fs.existsSync(dest)) { skipped++; continue; } // tránh đè
    fs.renameSync(path.join(srcDir, f), dest);
    moved++;
  }
  log(`   → moved ${moved}${skipped ? `, skip ${skipped} (đã tồn tại)` : ""}`);
}

const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
const existed = db.prepare("SELECT 1 FROM shop_niche WHERE shop=? AND niche_key=?").get(DST, NICHE);
log(`[NGÁCH] ${existed ? "đã có" : "thêm"} shop_niche(${DST}, ${NICHE})`);
if (apply && !existed) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO shop_niche (shop, niche_key, status, created_at, updated_at) VALUES (?, ?, 'testing', ?, ?) ON CONFLICT(shop, niche_key) DO NOTHING"
  ).run(DST, NICHE, now, now);
}
db.close();
log(apply ? "\n✅ XONG." : "\n(DRY-RUN) thêm --apply để chạy.");
