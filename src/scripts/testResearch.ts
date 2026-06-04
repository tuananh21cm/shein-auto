/**
 * Smoke test vòng research P1: chạy dailyResearch thật (RapidAPI) → in candidate.
 * Usage: npx tsx src/scripts/testResearch.ts
 */
import "dotenv/config";
import { runDailyResearch } from "../core/research/dailyResearch";
import { researchStore } from "../state/researchStore";

const main = async () => {
  const r = await runDailyResearch({ onLog: (m) => console.log(m) });

  console.log("\n=== TOP NGÁCH NÓNG ===");
  for (const n of r.topNiches) {
    console.log(`  ${n.key.padEnd(16)} heat=${n.heat} supply=${n.supply}`);
  }

  console.log("\n=== TOP 15 CANDIDATE ===");
  const { items } = researchStore.listCandidates({ day: r.day, status: "new", limit: 15 });
  for (const c of items) {
    console.log(
      `[${String(c.opportunityScore).padStart(3)}] ${c.nicheKey.padEnd(14)} ` +
        `$${c.finalPrice ?? "-"} | ${(c.name || "").slice(0, 45)}`
    );
    console.log(`      ${c.reason}`);
  }

  if (r.errors.length) {
    console.log("\n⚠️ Lỗi ngách:", r.errors.map((e) => `${e.niche}(${e.error})`).join(", "));
  }
  console.log(`\nDone: ${r.candidates} candidate / ${r.productsScored} sp / ${r.nichesScanned} ngách`);
};

main().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
