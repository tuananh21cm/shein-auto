/**
 * shopAssign — gán NGÁCH cho 1 SHOP (ghi bảng shop_niche). Mỗi shop 1-2 ngách.
 *
 * Usage:
 *   npx tsx src/scripts/shopAssign.ts list                       → xem mapping hiện tại + danh sách shop
 *   npx tsx src/scripts/shopAssign.ts "<shop>" "<niche_key>"     → gán (khớp tên shop 1 phần)
 *   npx tsx src/scripts/shopAssign.ts "<shop>" "<niche>" remove  → bỏ gán
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = () => {
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const argv = process.argv.slice(2);

  const knownShops = (db.prepare("SELECT DISTINCT folder FROM history WHERE folder LIKE 'TA %' OR folder LIKE '%_US'").all() as any[]).map((r) => r.folder);

  if (argv[0] === "list" || argv.length === 0) {
    const map = db.prepare("SELECT shop, niche_key, status FROM shop_niche ORDER BY shop").all();
    db.close();
    return out({ ok: true, mapping: map, knownShops });
  }

  const remove = argv[argv.length - 1] === "remove";
  if (remove) argv.pop();
  const niche = argv.pop()?.trim();
  const shopArg = argv.join(" ").trim();
  if (!shopArg || !niche) { db.close(); return out({ ok: false, error: 'Dùng: shopAssign "<shop>" "<niche_key>"' }); }

  // resolve shop từ known shops (khớp 1 phần)
  const matches = knownShops.filter((s) => s.toLowerCase().includes(shopArg.toLowerCase()));
  if (matches.length === 0) { db.close(); return out({ ok: false, error: `Không thấy shop khớp "${shopArg}"`, knownShops }); }
  if (matches.length > 1) { db.close(); return out({ ok: false, error: `"${shopArg}" khớp nhiều shop — nói rõ hơn`, matches }); }
  const shop = matches[0];

  if (remove) {
    db.prepare("DELETE FROM shop_niche WHERE shop=? AND niche_key=?").run(shop, niche);
    db.close();
    return out({ ok: true, action: "removed", shop, niche });
  }

  const n = Date.now();
  db.prepare(
    `INSERT INTO shop_niche (shop, niche_key, status, created_at, updated_at) VALUES (?,?, 'scaling', ?, ?)
     ON CONFLICT(shop, niche_key) DO UPDATE SET status='scaling', updated_at=?`
  ).run(shop, niche, n, n, n);
  const map = db.prepare("SELECT shop, niche_key, status FROM shop_niche WHERE shop=?").all(shop);
  db.close();
  out({ ok: true, action: "assigned", shop, niche, shopNiches: map });
};

main();
