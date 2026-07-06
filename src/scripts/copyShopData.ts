/**
 * copyShopData — nhân bản pipeline 2 shop cũ (dính lỗi, khó scale) sang 2 shop MỚI:
 *   - COPY file JSON đã list (folder Success/) → pending của shop mới (shop cũ GIỮ nguyên).
 *   - MOVE row uncrawl shop_allocation status allocated+recrawl → shop mới (goods_id là PK
 *     toàn cục nên buộc move, không copy).
 *   - Kế thừa NGÁCH (shop_niche.niche_key) cho shop mới để hệ thống nhận diện + pull-more.
 *
 * Dry-run mặc định. Thêm --apply để thực thi.
 *   npx tsx src/scripts/copyShopData.ts [--apply]
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const base = process.env.BASE_SHEINAUTO_DIR || "C:/Users/KBT/Downloads/SheinAuto";

const MAP = [
  { old: "TA Scan 227-Energetic Flags_US", new: "TN Scan43-reverend patty G_US", niche: "cami-top" },
  { old: "TA Scan 228-Street Clownin_US", new: "TN Scan44-Bawse Accessories & Design_US", niche: "underwear-sets" },
];
const MOVE_STATUSES = ["allocated", "recrawl"]; // chỉ link CHƯA cào

const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
const now = Date.now();
const log = (m: string) => console.log(m);

log(apply ? "▶️ APPLY — thực thi thật\n" : "🔍 DRY-RUN (thêm --apply để chạy thật)\n");

for (const m of MAP) {
  log(`=== ${m.old}  →  ${m.new}  (ngách ${m.niche}) ===`);
  const oldDir = path.join(base, m.old);
  const newDir = path.join(base, m.new);
  const oldSuccess = path.join(oldDir, "Success");

  // 1. COPY JSON Success → pending shop mới
  const jsonFiles = fs.existsSync(oldSuccess)
    ? fs.readdirSync(oldSuccess).filter((f) => f.toLowerCase().endsWith(".json"))
    : [];
  log(`  [JSON] ${jsonFiles.length} file ở Success/ → copy sang pending ${m.new}`);
  if (apply) {
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    let copied = 0, skipped = 0;
    for (const f of jsonFiles) {
      const dest = path.join(newDir, f);
      if (fs.existsSync(dest)) { skipped++; continue; } // tránh ghi đè nếu chạy lại
      fs.copyFileSync(path.join(oldSuccess, f), dest);
      copied++;
    }
    log(`         → đã copy ${copied}${skipped ? `, bỏ qua ${skipped} (đã tồn tại)` : ""}`);
  }

  // 2. MOVE row uncrawl (allocated+recrawl) → shop mới
  const ph = MOVE_STATUSES.map(() => "?").join(",");
  const cntRows = db
    .prepare(`SELECT status, COUNT(*) c FROM shop_allocation WHERE shop=? AND status IN (${ph}) GROUP BY status`)
    .all(m.old, ...MOVE_STATUSES) as any[];
  const total = cntRows.reduce((s, r) => s + r.c, 0);
  log(`  [UNCRAWL] ${total} row (${cntRows.map((r) => r.status + "=" + r.c).join(", ") || "0"}) → move shop=${m.new}`);
  if (apply && total > 0) {
    // OR IGNORE: PK (goods_id, shop) — nếu shop mới đã có sp đó thì bỏ qua row (không vỡ).
    const res = db
      .prepare(`UPDATE OR IGNORE shop_allocation SET shop=? WHERE shop=? AND status IN (${ph})`)
      .run(m.new, m.old, ...MOVE_STATUSES);
    log(`            → đã chuyển ${res.changes} row`);
  }

  // 3. Kế thừa ngách (không kế thừa kiki_profile — shop mới có profile riêng)
  const existed = db.prepare("SELECT 1 FROM shop_niche WHERE shop=? AND niche_key=?").get(m.new, m.niche);
  log(`  [NGÁCH] ${existed ? "đã có" : "thêm"} shop_niche(${m.new}, ${m.niche})`);
  if (apply && !existed) {
    db.prepare(
      `INSERT INTO shop_niche (shop, niche_key, status, created_at, updated_at)
       VALUES (?, ?, 'testing', ?, ?) ON CONFLICT(shop, niche_key) DO NOTHING`
    ).run(m.new, m.niche, now, now);
  }
  log("");
}

db.close();
log(apply ? "✅ XONG. Lưu ý: shop mới cần được thêm vào 4Seller (cookie) + gán Kiki profile + brand để list thật."
          : "(DRY-RUN) Kiểm tra số liệu trên rồi chạy lại với --apply.");
