/**
 * migrateShops — thay 2 shop coates grafx + Ari & Co bằng KellieJo.bluetapelife + Urban Noble.
 * Kế thừa ngách + kiki profile, CHUYỂN toàn bộ hàng đã phân bổ/cào sang shop mới, đổi brand.
 * Dry-run mặc định; thêm --apply để thực thi.
 * Usage: npx tsx src/scripts/migrateShops.ts [--apply]
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const base = process.env.BASE_SHEINAUTO_DIR || "C:/Users/KBT/Downloads/SheinAuto";

// old shop (hyphen, dùng trong shop_niche/shop_allocation/folder) → new
const MAP = [
  {
    old: "TA Scan 164-coates grafx supply co_US",
    oldEmdash: "TA Scan 164 — coates grafx supply co_US",
    new: "TA Scan 210-KellieJo.bluetapelife_US",
    brand: "BLUELIFE",
  },
  {
    old: "TA Scan 177-Ari & Co_US",
    oldEmdash: "TA Scan 177 — Ari & Co_US",
    new: "TA Scan 205-Urban Noble_US",
    brand: "LACEX",
  },
];

const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
const now = Date.now();
const log = (m: string) => console.log(m);

for (const m of MAP) {
  log(`\n=== ${m.old}  →  ${m.new}  (brand ${m.brand}) ===`);

  // 1. shop_niche: đổi tên shop, GIỮ niche_key + kiki_profile
  const niche = db.prepare("SELECT niche_key, kiki_profile FROM shop_niche WHERE shop=?").get(m.old) as any;
  log(`  shop_niche: ngách=${niche?.niche_key} kiki=${(niche?.kiki_profile || "").slice(0, 12)} (kế thừa)`);

  // 2. shop_allocation: số sp sẽ chuyển
  const cnt = db.prepare("SELECT status, COUNT(*) c FROM shop_allocation WHERE shop=? GROUP BY status").all(m.old) as any[];
  log(`  shop_allocation: ${cnt.map((x) => x.status + ":" + x.c).join(", ")} → chuyển sang shop mới`);

  // 3. folder JSON đã cào
  const oldDir = path.join(base, m.old);
  const newDir = path.join(base, m.new);
  const jsonFiles = fs.existsSync(oldDir) ? fs.readdirSync(oldDir).filter((f) => f.endsWith(".json")) : [];
  log(`  folder: ${jsonFiles.length} file JSON ${oldDir} → ${newDir}`);

  if (apply) {
    db.prepare("UPDATE shop_niche SET shop=?, updated_at=? WHERE shop=?").run(m.new, now, m.old);
    db.prepare("UPDATE shop_allocation SET shop=? WHERE shop=?").run(m.new, m.old);
    // move JSON files
    if (jsonFiles.length) {
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      for (const f of jsonFiles) fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
    }
    // xoá folder cũ nếu rỗng
    try {
      if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
    } catch { /* ignore */ }
  }
}

// 4. users(admin): profiles + brand_profiles_override
const admin = db.prepare("SELECT profiles, brand_profiles_override FROM users WHERE username='admin'").get() as any;
let profiles: string[] = JSON.parse(admin.profiles || "[]");
const brandObj = JSON.parse(admin.brand_profiles_override || "{}");
brandObj.profiles = brandObj.profiles || {};
for (const m of MAP) {
  // profiles: bỏ tên cũ (cả 2 dạng dấu), thêm tên mới
  profiles = profiles.filter((p) => p !== m.old && p !== m.oldEmdash);
  if (!profiles.includes(m.new)) profiles.push(m.new);
  // brand: bỏ key cũ, thêm key mới
  delete brandObj.profiles[m.old];
  delete brandObj.profiles[m.oldEmdash];
  brandObj.profiles[m.new] = m.brand;
}
log(`\n=== users(admin) ===`);
log(`  profiles: ${JSON.stringify(profiles)}`);
log(`  brands: ${JSON.stringify(brandObj.profiles)}`);
if (apply) {
  db.prepare("UPDATE users SET profiles=?, brand_profiles_override=?, updated_at=? WHERE username='admin'").run(
    JSON.stringify(profiles),
    JSON.stringify(brandObj),
    now
  );
}

db.close();
log(`\n${apply ? "✅ ĐÃ THỰC THI migration." : "(DRY-RUN) thêm --apply để chạy thật."}`);
