/** Kiểm tra shop có listing active + có data view chưa (quyết định gen video được không). */
import "dotenv/config";
import { getShopList, getListingPage } from "../services/fourseller/client";
import { resolveAccountForShop } from "../state/fourSellerAccounts";
import { TiktokDb } from "../services/tiktok/db";

const shops = (process.argv.slice(2).find((a) => a.startsWith("--shops=")) ?? "--shops=")
  .slice(8).split(",").map((s) => s.trim()).filter(Boolean);

const main = async () => {
  const t = new TiktokDb();
  const tracked = t.listTrackedShops();
  t.close();

  for (const shop of shops) {
    const acct = await resolveAccountForShop(shop);
    if (!acct) { console.log(`${shop}: KHÔNG thuộc tài khoản 4Seller nào`); continue; }
    const principal = `acct:${acct.uid}`;
    const list = await getShopList(principal);
    const rec = (list?.records ?? []).find((s: any) => s.shopName === shop);
    if (!rec) { console.log(`${shop}: không thấy trên 4Seller`); continue; }
    const page = await getListingPage(principal, { shopId: rec.id, status: "active", pageSize: 1 });
    console.log(
      `${shop}\n   listing active: ${page.total ?? 0} | data view: ${tracked.includes(shop) ? "CÓ" : "CHƯA (cần crawl)"}`
    );
  }
};
main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
