/**
 * Dump full field set của list API record (1 shop, 1 page) để biết
 * chấm điểm shop được dựa trên field nào mà KHÔNG cần gọi detail.
 *
 * Usage: npx tsx src/scripts/inspectListFields.ts --user=tuananh
 */
import "dotenv/config";
import { getShopList, getListingPage } from "../services/fourseller/client";

const main = async () => {
  const userArg = process.argv.slice(2).find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length) || "tuananh";

  const shops = await getShopList(username);
  console.log(`Shops: ${shops.records.length}`);
  const shop = shops.records[0];
  console.log(`Sample shop: ${shop.shopName} (id=${shop.id})`);

  const page = await getListingPage(username, {
    shopId: shop.id,
    status: "active",
    pageCurrent: 1,
    pageSize: 3,
  });
  console.log(`Total active: ${page.total}, records: ${page.records.length}`);

  const rec = page.records[0];
  if (!rec) return console.log("Shop rỗng, thử shop khác.");

  console.log("\n=== RECORD KEYS ===");
  console.log(Object.keys(rec).join(", "));

  console.log("\n=== FIELD VALUES (trừ ảnh) ===");
  for (const k of Object.keys(rec)) {
    let v: any = (rec as any)[k];
    if (k === "mainImage" && typeof v === "string") {
      console.log(`${k} = [${v.split("|").length} images]`);
      continue;
    }
    if (typeof v === "string" && v.length > 200) v = v.slice(0, 200) + "…";
    console.log(`${k} = ${JSON.stringify(v)}`);
  }
};

main().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
