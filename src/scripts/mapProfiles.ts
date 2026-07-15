/**
 * Map shop → Kiki profile. Nhận cặp "shopNameSubstr=profileId", phân cách bằng ';'.
 * Tự khớp tên shop đầy đủ trên 4Seller từ chuỗi con.
 * Usage:
 *   npx tsx src/scripts/mapProfiles.ts "Scan13 - 226=6a39...;Scan14 - 226=6a39..."
 */
import "dotenv/config";
import { listAccounts } from "../state/fourSellerAccounts";
import { getShopList } from "../services/fourseller/client";
import { EditDb } from "../services/tiktok/editDb";

const main = async () => {
  const pairs = (process.argv[2] ?? "").split(";").map((s) => s.trim()).filter(Boolean)
    .map((p) => { const [k, v] = p.split("="); return { sub: k.trim(), profile: v.trim() }; });
  if (!pairs.length) throw new Error('Cần arg: "sub=profileId;sub=profileId"');

  // Gom tên shop đầy đủ từ mọi tài khoản 4Seller
  const shopNames: string[] = [];
  for (const a of await listAccounts()) {
    const res = await getShopList(`acct:${a.uid}`).catch(() => null);
    for (const s of res?.records ?? []) shopNames.push(s.shopName);
  }

  const db = new EditDb();
  for (const { sub, profile } of pairs) {
    const full = shopNames.find((n) => n.toLowerCase().includes(sub.toLowerCase()));
    if (!full) { console.log(`❌ Không tìm thấy shop khớp "${sub}"`); continue; }
    db.setProfile(full, profile);
    console.log(`✅ ${full}  →  ${db.getProfile(full)}`);
  }
  db.close();
};
main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
