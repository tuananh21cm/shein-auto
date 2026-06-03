/**
 * Test 4Seller API client với cookie user.
 * Usage: npx tsx src/scripts/testFourSeller.ts --user=tuananh
 */
import "dotenv/config";
import { getShopList, getStatusCount, getListingPage } from "../services/fourseller/client";

const main = async () => {
  const userArg = process.argv.find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length) || "tuananh";

  console.log(`▶️ Test 4Seller API với user "${username}"\n`);

  console.log("1. getShopList...");
  const shops = await getShopList(username);
  console.log(`✅ ${shops.records.length} shops`);
  console.log("   First 5:");
  for (const s of shops.records.slice(0, 5)) {
    console.log(`     • id=${s.id}  shopName="${s.shopName}"  platformShopName="${s.platformShopName}"  market=${s.marketplaceId}`);
  }

  console.log("\n2. getStatusCount (global, all shops)...");
  const globalCount = await getStatusCount(username);
  console.log(`✅`, globalCount);

  // Pick first shop với 'P5-' prefix để test per-shop count
  const p5Shop = shops.records.find((s) => /^P5-/i.test(s.shopName));
  if (p5Shop) {
    console.log(`\n3. getStatusCount cho shop "${p5Shop.shopName}" (id=${p5Shop.id})...`);
    const shopCount = await getStatusCount(username, { shopId: p5Shop.id });
    console.log(`✅`, shopCount);

    console.log(`\n4. getListingPage status=active cho shop "${p5Shop.shopName}"...`);
    const page = await getListingPage(username, { shopId: p5Shop.id, status: "active", pageSize: 5 });
    console.log(`✅ Total ${page.total} listings. First 5 records:`);
    for (const r of page.records.slice(0, 5)) {
      console.log(`     • id=${r.id}  productId=${r.productId}  status=${r.publishStatus ?? r.erpStatus}`);
    }
  } else {
    console.log("⚠️ Không tìm thấy shop nào có prefix P5-");
  }
};

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
