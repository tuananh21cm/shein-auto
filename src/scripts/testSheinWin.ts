/**
 * Smoke test SHEIN client + win score.
 * Usage: npx tsx src/scripts/testSheinWin.ts [keyword]
 */
import "dotenv/config";
import { searchProducts, getProductDetail, bestSellersByCategory } from "../services/shein/client";
import { rankByWin } from "../core/winScore";

const main = async () => {
  const kw = process.argv.slice(2).join(" ") || "summer dress";

  console.log(`🔎 Search "${kw}"...`);
  const res = await searchProducts(kw, { perPage: 40 });
  console.log(`Total ~${res.total}, lấy ${res.products.length} sp`);
  const ranked = rankByWin(res.products);

  console.log("\n=== TOP 8 WIN ===");
  for (const p of ranked.slice(0, 8)) {
    console.log(
      `[${p.winTier.toUpperCase().padEnd(6)}] ${String(p.winScore).padStart(3)} | ` +
      `rev=${String(p.commentNum).padStart(5)} rate=${p.rating ?? "-"} ` +
      `$${p.price ?? "-"}${p.discountPct ? ` (-${p.discountPct}%)` : ""} | ` +
      `${(p.name || "").slice(0, 55)} | gid=${p.goodsId}`
    );
  }

  // Detail của sp top 1
  const top = ranked[0];
  if (top) {
    console.log(`\n🔍 Detail goods_id=${top.goodsId}...`);
    try {
      const d = await getProductDetail(top.goodsId, { goodsSn: top.goodsSn });
      console.log(`Name: ${d.name.slice(0, 70)}`);
      console.log(`Source: ${d.source} | Price: $${d.price} | Images: ${d.images.length} | Attrs: ${d.attributes.length} | Material: ${d.material.length}`);
      console.log(`Material:`, d.material.slice(0, 3).map((m) => `${m.name}${m.value}`).join(" | "));
    } catch (e: any) {
      console.log("Detail lỗi:", e.message);
    }
  }
};

main().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
