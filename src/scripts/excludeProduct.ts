/**
 * excludeProduct — SOFT-DELETE sản phẩm: loại khỏi list (không list, không cào lại), giữ data.
 * Dùng khi sếp nhìn album báo cáo rồi bảo "bỏ số 5" → agent map số 5 → goods_id → gọi lệnh này.
 *
 * Usage:
 *   npx tsx src/scripts/excludeProduct.ts <goods_id> [<goods_id> ...]   → loại (soft delete)
 *   npx tsx src/scripts/excludeProduct.ts list                          → xem danh sách đã loại
 *   npx tsx src/scripts/excludeProduct.ts restore <goods_id>            → bỏ loại (cho list lại)
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = () => {
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS excluded_products (goods_id TEXT PRIMARY KEY, reason TEXT, excluded_at INTEGER)`);
  const argv = process.argv.slice(2);

  if (argv[0] === "list") {
    const rows = db.prepare("SELECT goods_id, reason FROM excluded_products ORDER BY excluded_at DESC").all();
    db.close();
    return out({ ok: true, count: rows.length, excluded: rows });
  }
  if (argv[0] === "restore") {
    const ids = argv.slice(1);
    const del = db.prepare("DELETE FROM excluded_products WHERE goods_id=?");
    let n = 0; for (const id of ids) n += del.run(id).changes;
    // trả allocation về 'allocated' nếu đang excluded
    const upd = db.prepare("UPDATE shop_allocation SET status='allocated' WHERE goods_id=? AND status='excluded'");
    for (const id of ids) try { upd.run(id); } catch {}
    db.close();
    return out({ ok: true, restored: n, ids });
  }

  const ids = argv.filter(Boolean);
  if (!ids.length) { db.close(); return out({ ok: false, error: "Thiếu goods_id. Dùng: excludeProduct.ts <goods_id> ..." }); }

  const ins = db.prepare("INSERT OR IGNORE INTO excluded_products (goods_id, reason, excluded_at) VALUES (?,?,?)");
  const hasAlloc = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_allocation'").get();
  const updAlloc = hasAlloc ? db.prepare("UPDATE shop_allocation SET status='excluded' WHERE goods_id=?") : null;

  let excluded = 0, fromShop = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      excluded += ins.run(id, "user bỏ qua album report", Date.now()).changes;
      if (updAlloc) fromShop += updAlloc.run(id).changes;
    }
  });
  tx();
  db.close();
  out({ ok: true, excludedNew: excluded, removedFromShopQueue: fromShop, ids, note: "Đã soft-delete: sẽ KHÔNG được phân bổ/cào/list nữa. Khôi phục bằng 'restore <goods_id>'." });
};

main();
