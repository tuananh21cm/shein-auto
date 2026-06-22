/**
 * fourSellerStatus — "dashboard" list hàng 4Seller: test cookie + tóm tắt history (success/fail).
 * Usage: npx tsx src/scripts/fourSellerStatus.ts [--user=tuananh]
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { getShopList } from "../services/fourseller/client";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = async () => {
  const userArg = process.argv.find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length) || "tuananh";

  // 1) Test cookie qua getShopList
  let cookie: any = { ok: false };
  try {
    const shops = await getShopList(username);
    cookie = { ok: true, user: username, shopCount: shops.records.length, shops: shops.records.slice(0, 10).map((s: any) => ({ id: s.id, name: s.shopName })) };
  } catch (e: any) {
    cookie = { ok: false, user: username, error: `Cookie lỗi/hết hạn: ${e?.message ?? e}` };
  }

  // 2) History summary
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
  let history: any = {};
  try {
    const byStatus = db.prepare("SELECT status, COUNT(*) n FROM history GROUP BY status").all() as any[];
    const recentFails = db.prepare(
      "SELECT file, folder, error_message FROM history WHERE status='fail' ORDER BY finished_at DESC LIMIT 5"
    ).all() as any[];
    history = {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      recentFails: recentFails.map((r) => ({ file: r.file, shop: r.folder, error: (r.error_message || "").slice(0, 120) })),
    };
  } catch (e: any) { history = { error: String(e?.message ?? e) }; }
  db.close();

  out({ ok: true, cookie, history });
};

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }));
