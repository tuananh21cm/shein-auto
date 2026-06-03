/**
 * Smoke test chấm điểm shop trên data thật (không gọi AI).
 * Usage: npx tsx src/scripts/testShopScore.ts --user=tuananh [--shop=<id>]
 */
import "dotenv/config";
import { getShopList, getListingPage, getCategoryById } from "../services/fourseller/client";
import { computeShopScore, type ScoreListing } from "../core/shopScore";

const main = async () => {
  const args = process.argv.slice(2);
  const u = args.find((a) => a.startsWith("--user="))?.slice(7) || "tuananh";
  const shopArg = args.find((a) => a.startsWith("--shop="))?.slice(7);

  const shops = await getShopList(u);
  const shop = shopArg
    ? shops.records.find((s) => String(s.id) === shopArg)!
    : shops.records[0];
  console.log(`Shop: ${shop.shopName} (id=${shop.id}, site=${shop.site || "US"})`);

  const listings: ScoreListing[] = [];
  let pageCurrent = 1;
  let total = 0;
  do {
    const page = await getListingPage(u, { shopId: shop.id, status: "active", pageCurrent, pageSize: 100 });
    total = page.total;
    for (const r of page.records as any[]) {
      listings.push({
        id: r.id, productName: r.productName, mainImage: r.mainImage, categoryId: r.categoryId,
        lowPrice: r.lowPrice, highPrice: r.highPrice, originalPrice: r.originalPrice,
        availableStock: r.availableStock, variationCount: r.variationCount,
        errMsg: r.errMsg, failedMessage: r.failedMessage,
      });
    }
    if (page.records.length < 100) break;
    pageCurrent++;
  } while ((pageCurrent - 1) * 100 < total);

  const cids = [...new Set(listings.map((l) => String(l.categoryId || "unknown")))].filter((x) => x !== "unknown");
  const names: Record<string, { name: string; nodePath: string }> = {};
  for (const c of cids) {
    try {
      const i = await getCategoryById(u, c, shop.site || "US", shop.id);
      names[c] = { name: i.categoryName, nodePath: i.nodePath };
    } catch {
      names[c] = { name: c, nodePath: "" };
    }
  }

  const score = computeShopScore(listings, names);
  console.log(`Listings tải: ${listings.length} / total ${total}`);
  console.log(`OVERALL: ${score.scores.overall} (Grade ${score.scores.grade})`);
  console.log("Sub-scores:", JSON.stringify(score.scores));
  console.log("Niche:", JSON.stringify({ count: score.niche.categoryCount, top: score.niche.topShare, top3: score.niche.top3Share, chaotic: score.niche.chaotic }));
  console.log("Issue counts:", JSON.stringify(Object.fromEntries(Object.entries(score.issues).map(([k, v]) => [k, v.count]))));
  console.log("Top categories:", score.niche.categories.slice(0, 5).map((c) => `${c.categoryName}(${c.percent}%)`).join(", "));
};

main().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
