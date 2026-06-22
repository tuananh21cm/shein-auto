/** Test P3: chạy collectKalodata thật qua Kiki → lưu store → in top demand. */
import "dotenv/config";
import { collectKalodata } from "../services/kalodata/client";
import { kalodataStore } from "../state/kalodataStore";
import { readKikiConfig } from "../services/kiki/config";
import { today } from "../state/researchStore";

(async () => {
  const profileId = readKikiConfig().profiles[0]?.id;
  if (!profileId) throw new Error("Chưa có Kiki profile");
  const r = await collectKalodata({ profileId, categoryPages: 3, productPages: 3, onLog: (m) => console.log(m) });

  const day = today();
  kalodataStore.saveCategories(day, r.categories);
  kalodataStore.saveProducts(day, r.products);

  console.log("\n=== TOP 8 NGÁCH (revenue) ===");
  for (const c of r.categories.slice(0, 8)) {
    console.log(`  L${c.level} ${c.name.padEnd(28)} rev=${c.revenue ? (c.revenue / 1e9).toFixed(0) + "b" : "?"} growth=${c.growthRate != null ? (c.growthRate * 100).toFixed(1) + "%" : "?"} top10=${c.top10Ratio != null ? (c.top10Ratio * 100).toFixed(0) + "%" : "?"} slope=${c.trendSlope ?? "?"}`);
  }
  console.log("\n=== TOP 6 PRODUCT (revenue) ===");
  for (const p of r.products.slice(0, 6)) {
    console.log(`  ${p.isLocal ? "🏠" : "✈️"} sale=${p.sale} rev=${p.revenue ? (p.revenue / 1e9).toFixed(1) + "b" : "?"} ★${p.rating ?? "-"} | ${(p.title || "").slice(0, 45)}`);
  }
  console.log(`\nĐã lưu ${r.categories.length} category + ${r.products.length} product (day=${day}).`);
})().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
