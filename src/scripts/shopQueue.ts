/**
 * shopQueue — lấy "batch hôm nay" cho 1 shop: N sp đã phân bổ (shop_allocation) mà CHƯA list.
 *
 * Usage:
 *   npx tsx src/scripts/shopQueue.ts "<shop>" [N]          → XEM next N (read-only, mặc định 10)
 *   npx tsx src/scripts/shopQueue.ts "<shop>" [N] done     → lấy N rồi ĐÁNH DẤU đã list (cursor tiến)
 *
 * Tên shop khớp 1 phần cũng được (vd "MaeBLa" khớp "TA Scan150-MaeBLa_US").
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = () => {
  const argv = process.argv.slice(2);
  const markDone = argv[argv.length - 1] === "done";
  if (markDone) argv.pop();
  const n = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 10;
  const shopArg = argv.join(" ").trim();
  if (!shopArg) return out({ ok: false, error: 'Thiếu shop. Dùng: npx tsx src/scripts/shopQueue.ts "MaeBLa" 10' });

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const exists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_allocation'").get());
  if (!exists) { db.close(); return out({ ok: false, error: "Chưa có shop_allocation — chạy shopAllocate trước." }); }

  // resolve shop (khớp 1 phần)
  const shopRow = db.prepare("SELECT DISTINCT shop FROM shop_allocation WHERE shop LIKE '%'||?||'%' LIMIT 1").get(shopArg) as any;
  if (!shopRow) { db.close(); return out({ ok: false, error: `Không có sp nào phân bổ cho shop khớp "${shopArg}". Chạy shopAllocate, hoặc gán ngách cho shop.` }); }
  const shop = shopRow.shop;

  const rows = db.prepare(
    `SELECT goods_id, name, niche_key, win_score, opportunity_score, price, url, image
     FROM shop_allocation WHERE shop=? AND status='allocated'
     ORDER BY opportunity_score DESC LIMIT ?`
  ).all(shop, n) as any[];

  const totals = db.prepare(
    `SELECT COUNT(*) total, SUM(status='listed') listed, SUM(status='allocated') pending FROM shop_allocation WHERE shop=?`
  ).get(shop) as any;

  if (markDone && rows.length) {
    const upd = db.prepare("UPDATE shop_allocation SET status='listed', listed_at=? WHERE goods_id=? AND shop=?");
    const tx = db.transaction(() => { for (const r of rows) upd.run(Date.now(), r.goods_id, shop); });
    tx();
  }

  db.close();
  out({
    ok: true, shop, batchSize: rows.length, markedListed: markDone,
    progress: { total: totals.total, listed: (totals.listed || 0) + (markDone ? rows.length : 0), pending: (totals.pending || 0) - (markDone ? rows.length : 0) },
    items: rows.map((r) => ({ name: (r.name || "").slice(0, 60), niche: r.niche_key, win: r.win_score, opp: r.opportunity_score, price: r.price, url: r.url, image: r.image })),
  });
};

main();
