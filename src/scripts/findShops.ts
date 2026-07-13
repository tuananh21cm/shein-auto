/** Tìm shop trên 4Seller theo chuỗi con (để map Kiki profile đúng tên shop). */
import "dotenv/config";
import { listAccounts } from "../state/fourSellerAccounts";
import { getShopList } from "../services/fourseller/client";

const q = (process.argv.slice(2).find((a) => a.startsWith("--q=")) ?? "--q=").slice(4)
  .split(",").map((s) => s.trim()).filter(Boolean);

const main = async () => {
  const accs = await listAccounts();
  for (const a of accs) {
    const res = await getShopList(`acct:${a.uid}`).catch(() => null);
    for (const s of res?.records ?? []) {
      if (!q.length || q.some((x) => s.shopName.toLowerCase().includes(x.toLowerCase()))) {
        console.log(`${s.shopName.padEnd(40)} | id=${s.id} | acct=${a.label}`);
      }
    }
  }
};
main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
