/** Smoke test P4: gọi Gemini briefing cho ngày mới nhất. Usage: npx tsx src/scripts/testResearchAI.ts */
import "dotenv/config";
import { generateResearchBriefing } from "../services/gemini/researchInsights";
import { researchStore } from "../state/researchStore";

(async () => {
  const r = await generateResearchBriefing({ onLog: (m) => console.log(m) });
  console.log("\n=== BRIEFING ===\n" + r.briefing);
  console.log("\n=== NGÁCH GỢI Ý ===");
  r.suggestions.forEach((s) => console.log(`  + ${s.key} (${s.query}) — ${s.why}`));
  console.log(`\nnotesApplied=${r.notesApplied}/${r.candidatesAnalyzed}`);
  const { items } = researchStore.listCandidates({ day: r.day, limit: 3 });
  console.log("\n=== 3 CANDIDATE (ai_reason) ===");
  items.forEach((c) => console.log(`  [${c.opportunityScore}] ${(c.name || "").slice(0, 35)}\n     🤖 ${c.aiReason || "(chưa có)"}`));
})().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
