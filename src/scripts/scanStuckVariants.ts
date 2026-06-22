/**
 * scanStuckVariants — quét các JSON đã cào, tìm listing dính bug "variant kẹt":
 * nhiều màu nhưng ảnh các màu TRÙNG nhau (click chỉ đổi URL, gallery không swap).
 * Usage: npx tsx src/scripts/scanStuckVariants.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const base = (process.env.BASE_SHEINAUTO_DIR || "C:/Users/KBT/Downloads/SheinAuto").replace(/\\/g, "/");
if (!fs.existsSync(base)) {
  console.log(JSON.stringify({ ok: false, error: `base không tồn tại: ${base}` }));
  process.exit(0);
}

// CHỈ quét 5 shop SHEIN (shop_niche). KHÔNG quét shop POD — POD dùng chung 1 ảnh design cho nhiều màu
//   là BÌNH THƯỜNG, quét vào sẽ false-positive + xoá nhầm file POD.
const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
const sheinShops = new Set(db.prepare("SELECT shop FROM shop_niche").all().map((r: any) => r.shop));
db.close();

const shops = fs.readdirSync(base).filter((d) => {
  try {
    return fs.statSync(path.join(base, d)).isDirectory() && sheinShops.has(d);
  } catch {
    return false;
  }
});

const bad: any[] = [];
let total = 0;
for (const shop of shops) {
  const dir = path.join(base, shop);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let j: any;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!j.listing_variations) continue;
    total++;
    const colors: string[] = j.listing_variations.colors || [];
    if (colors.length < 2) continue;
    const sigs: string[] = (j.variant_images || []).map((o: any) => {
      const k = Object.keys(o)[0];
      return (o[k] || []).slice(0, 3).join("|");
    });
    const uniq = new Set(sigs.filter(Boolean));
    // nghi kẹt: số bộ ảnh KHÁC nhau < 60% số màu (lý tưởng mỗi màu 1 bộ ảnh riêng).
    if (uniq.size > 0 && uniq.size < colors.length * 0.6) {
      bad.push({
        shop: shop.replace("TA Scan ", "").replace("_US", ""),
        file: f,
        colors: colors.length,
        uniqImgSets: uniq.size,
        name: (j.product_name || "").slice(0, 40),
        url: j.url,
      });
    }
  }
}

console.log(`Tổng JSON có >=2 màu: ${total}`);
console.log(`NGHI DÍNH BUG (ảnh trùng giữa các màu): ${bad.length}`);
for (const b of bad) {
  console.log(`  ❌ ${b.shop} | ${b.colors} màu nhưng chỉ ${b.uniqImgSets} bộ ảnh khác | ${b.name} | ${b.file}`);
}
