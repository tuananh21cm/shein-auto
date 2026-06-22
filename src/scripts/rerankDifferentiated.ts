/**
 * rerankDifferentiated — RE-ALLOCATE 1 shop từ pool research theo điểm "khác biệt" thay vì
 * opportunity_score (vốn bị review-count chi phối → toàn áo trơn bão hòa).
 *
 * Logic:
 *  - Phân loại mỗi sp theo họa tiết. Nhóm "bão hòa" = TRƠN/Vintage/Biển (review TB rất cao).
 *  - diffScore = thưởng rating cao + review VỪA (proven nhưng chưa tràn lan) + base rẻ,
 *    phạt nhóm bão hòa + review quá cao.
 *  - Chọn TARGET sp: ưu tiên graphic theo diffScore, GIỚI HẠN nhóm bão hòa ≤ SOLID_CAP_PCT.
 *  - Ghi đè shop_allocation (status='allocated') cho shop + set opportunity_score = thứ hạng mới
 *    để crawler (ORDER BY opportunity_score DESC) cào graphic trước.
 *
 * Usage: npx tsx src/scripts/rerankDifferentiated.ts "<shop khoá tìm>" [target] [--apply]
 *   vd: npx tsx src/scripts/rerankDifferentiated.ts "Priority Shop X" 75
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const pos = argv.filter((a) => !a.startsWith("--"));
const shopQuery = pos[0] || "Priority Shop X";
const TARGET = Number(pos[1]) > 0 ? Number(pos[1]) : 75;
const SOLID_CAP_PCT = 0.3;

const SATURATED = new Set(["TRƠN", "Vintage", "Biển"]);
const classify = (n: string): string => {
  const s = " " + n.toLowerCase() + " ";
  if (/\b(floral|hibiscus|flower|flowers|tropical|botanical|wildflower)\b/.test(s)) return "Hoa/Tropical";
  if (/\b(tiger|tigers|animal|leopard|turtle|whale|butterfly|dragon|snake|cow|cheetah)\b/.test(s)) return "Động vật";
  if (/\b(usa|american|america|flag|4th of july|independence|patriotic|western)\b/.test(s)) return "USA";
  if (/\b(lemon|fruit|orange|lime|cherry|beer|wine|coffee)\b/.test(s)) return "Fruit/Food";
  if (/\b(tie-dye|tie dye|acid wash|washed|distressed|vintage|retro|90s|grunge)\b/.test(s)) return "Vintage";
  if (/\bstrip/.test(s)) return "Sọc";
  if (/\b(ocean|beach|sea|wave|palm|surf)\b/.test(s)) return "Biển";
  if (/\b(star|stars|embroider|embroidered|patch)\b/.test(s)) return "Star/Embr";
  if (/\b(jesus|faith|god|christian|cross|bible)\b/.test(s)) return "Faith";
  if (/\b(letter|slogan|text|graphic tee|alphabet|word|wording)\b/.test(s)) return "Letter";
  if (/\b(camouflage|camo|tree|branch|nature|mountain)\b/.test(s)) return "Nature";
  if (/\b(solid|plain)\b/.test(s) && !/\b(print|printed|graphic|pattern)\b/.test(s)) return "TRƠN";
  return "Basic";
};

const diffScore = (r: any): number => {
  const theme = classify(r.name);
  const rating = r.rating || 0;
  const rev = r.comment_num || 0;
  // proven-but-not-saturated: thưởng review tới ~1500, phạt phần vượt 2500
  const proven = Math.min(rev, 1500) / 1500 * 30;
  const overSat = Math.max(0, rev - 2500) / 1000 * 8;
  const qual = (rating - 4.4) * 45; // rating là tín hiệu chất lượng in
  const cheap = r.price && r.price < 8 ? 6 : r.price && r.price < 10 ? 3 : 0;
  let s = qual + proven + cheap - overSat;
  if (SATURATED.has(theme)) s -= 35; // dìm nhóm bão hòa
  return s;
};

const main = () => {
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const shopRow = db.prepare(
    "SELECT shop, niche_key FROM shop_niche WHERE shop LIKE ?"
  ).get("%" + shopQuery + "%") as any;
  if (!shopRow) { console.log("❌ Không thấy shop khớp:", shopQuery); db.close(); return; }
  const { shop, niche_key } = shopRow;
  console.log(`Shop: ${shop} | ngách: ${niche_key} | target ${TARGET} | solid cap ${SOLID_CAP_PCT * 100}%\n`);

  const excluded = new Set(db.prepare("SELECT goods_id FROM excluded_products").all().map((r: any) => String(r.goods_id)));

  // pool, dedup theo goods_id (giữ review cao nhất)
  const raw = db.prepare(
    "SELECT goods_id, name, price, final_price, comment_num, rating, win_score, url, image FROM research_product WHERE niche_key=?"
  ).all(niche_key) as any[];
  const m = new Map<string, any>();
  for (const r of raw) {
    const k = String(r.goods_id);
    if (excluded.has(k)) continue;
    const e = m.get(k);
    if (!e || (r.comment_num || 0) > (e.comment_num || 0)) m.set(k, r);
  }
  const pool = [...m.values()].filter((r) => (r.rating || 0) >= 4.4 && (r.comment_num || 0) >= 50);
  for (const r of pool) { r.theme = classify(r.name); r.ds = diffScore(r); }
  pool.sort((a, b) => b.ds - a.ds);

  // chọn: graphic trước, solid (bão hòa) cap
  const solidCap = Math.floor(TARGET * SOLID_CAP_PCT);
  const chosen: any[] = [];
  let solidN = 0;
  for (const r of pool) {
    if (chosen.length >= TARGET) break;
    const isSat = SATURATED.has(r.theme);
    if (isSat && solidN >= solidCap) continue;
    chosen.push(r);
    if (isSat) solidN++;
  }
  // nếu thiếu (graphic ít), bù thêm solid để đủ TARGET
  if (chosen.length < TARGET) {
    for (const r of pool) {
      if (chosen.length >= TARGET) break;
      if (!chosen.includes(r)) chosen.push(r);
    }
  }

  // thống kê
  const byTheme: Record<string, number> = {};
  for (const r of chosen) byTheme[r.theme] = (byTheme[r.theme] || 0) + 1;
  console.log(`Đã chọn ${chosen.length} sp. Phân bổ theo họa tiết:`);
  Object.entries(byTheme).sort((a, b) => b[1] - a[1]).forEach(([t, c]) =>
    console.log(`  ${(SATURATED.has(t) ? "🔴 " : "🟢 ") + t}`.padEnd(22) + c));
  console.log(`  (nhóm bão hòa: ${solidN}/${chosen.length})\n`);
  console.log("Top 20 thứ tự cào mới:");
  chosen.slice(0, 20).forEach((r, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${(SATURATED.has(r.theme) ? "🔴" : "🟢")} ${r.theme.padEnd(12)} ⭐${(r.rating || 0).toFixed(2)} ${String(r.comment_num).padStart(4)}rev base$${(r.price || 0).toFixed(1)} | ${r.name.slice(0, 42)}`));

  if (!apply) {
    console.log(`\n(DRY-RUN) thêm --apply để ghi đè allocation. Lệnh:\n  npx tsx src/scripts/rerankDifferentiated.ts "${shopQuery}" ${TARGET} --apply`);
    db.close();
    return;
  }

  // GHI ĐÈ: xoá allocated cũ (giữ crawled/listed), insert mới với opportunity_score = thứ hạng
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM shop_allocation WHERE shop=? AND status='allocated'").run(shop);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO shop_allocation
       (goods_id, shop, niche_key, name, win_score, opportunity_score, price, url, image, status, allocated_at, listed_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'allocated', ?, NULL)`
    );
    const now = Date.now();
    chosen.forEach((r, i) => {
      // opportunity_score = thứ hạng đảo (cao = cào trước). 1000 - i để crawler ưu tiên graphic.
      ins.run(String(r.goods_id), shop, niche_key, r.name, r.win_score || 0, 1000 - i, r.price || 0, r.url, r.image, now);
    });
  });
  tx();
  const cnt = db.prepare("SELECT COUNT(*) c FROM shop_allocation WHERE shop=? AND status='allocated'").get(shop) as any;
  console.log(`\n✅ Ghi đè xong. ${shop} giờ có ${cnt.c} sp 'allocated' (thứ tự cào theo độ khác biệt).`);
  db.close();
};

main();
