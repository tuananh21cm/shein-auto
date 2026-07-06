/**
 * resetStuckVariants — reset các sp dính bug "variant kẹt" (ảnh các màu trùng nhau) về
 * status='allocated' + XOÁ JSON sai, để cào lại bằng scraper đã fix.
 * Dry-run mặc định; thêm --apply để thực thi.
 * Usage: npx tsx src/scripts/resetStuckVariants.ts [--apply]
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const base = process.env.BASE_SHEINAUTO_DIR || "C:/Users/KBT/Downloads/SheinAuto";

const detect = () => {
  // CHỈ quét 5 shop SHEIN (shop_niche). KHÔNG đụng folder POD (POD chung 1 ảnh nhiều màu = bình thường).
  const dbS = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const sheinShops = new Set(dbS.prepare("SELECT shop FROM shop_niche").all().map((r: any) => r.shop));
  dbS.close();
  const shops = fs.readdirSync(base).filter((d) => {
    try {
      return fs.statSync(path.join(base, d)).isDirectory() && sheinShops.has(d);
    } catch {
      return false;
    }
  });
  const bad: { shop: string; file: string; full: string; goodsId: string | null; colors: number; uniq: number }[] = [];
  for (const shop of shops) {
    const dir = path.join(base, shop);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const full = path.join(dir, f);
      let j: any;
      try {
        j = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      const colors: string[] = j.listing_variations?.colors || [];
      if (colors.length < 2) continue;
      const sigs: string[] = (j.variant_images || []).map((o: any) => {
        const k = Object.keys(o)[0];
        return (o[k] || []).slice(0, 3).join("|");
      });
      const uniq = new Set(sigs.filter(Boolean));
      if (uniq.size > 0 && uniq.size < colors.length * 0.6) {
        bad.push({ shop, file: f, full, goodsId: j.url?.match(/-p-(\d+)\.html/)?.[1] || null, colors: colors.length, uniq: uniq.size });
      }
    }
  }
  return bad;
};

const main = () => {
  const bad = detect();
  console.log(`Tìm thấy ${bad.length} sp dính bug variant kẹt.`);
  if (!bad.length) return;

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const reset = db.prepare("UPDATE shop_allocation SET status='allocated' WHERE goods_id=? AND shop=?");
  let resetN = 0;
  let delN = 0;
  for (const b of bad) {
    console.log(`  ${apply ? "RESET" : "[dry]"} ${b.shop.replace("TA Scan ", "").replace("_US", "")} | ${b.colors} màu/${b.uniq} ảnh | goods=${b.goodsId} | ${b.file}`);
    if (apply) {
      // CHỈ xử lý sp có goods_id (= sp SHEIN thật). goods=null → BỎ QUA, KHÔNG xoá (an toàn, tránh xoá nhầm).
      if (b.goodsId) {
        reset.run(b.goodsId, b.shop);
        resetN++;
        try { fs.unlinkSync(b.full); delN++; } catch { /* ignore */ }
      } else {
        console.log(`    ⏭️  bỏ qua (goods=null, không phải sp SHEIN) — KHÔNG xoá.`);
      }
    }
  }
  db.close();
  if (apply) console.log(`✅ Reset ${resetN} sp về 'allocated', xoá ${delN} JSON sai. Cào lại bằng crawlAllocated (scraper đã fix).`);
  else console.log(`\n(DRY-RUN) thêm --apply để reset về 'allocated' + xoá JSON. Chạy: npx tsx src/scripts/resetStuckVariants.ts --apply`);
};

main();
