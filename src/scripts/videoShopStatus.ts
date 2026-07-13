/** Shop nào có data view (gen video được), có video ready, đã map Kiki profile chưa. */
import { TiktokDb } from "../services/tiktok/db";
import { EditDb } from "../services/tiktok/editDb";
import { VideoDb } from "../state/videoDb";

const tdb = new TiktokDb();
const edb = new EditDb();
const vdb = new VideoDb();

const tracked = tdb.listTrackedShops();
console.log(`=== SHOP CÓ DATA VIEW (gen video được): ${tracked.length} ===`);
for (const s of tracked) {
  const cand = tdb.getFlashCandidates(s, { limit: 999 });
  const ready = vdb.list({ shop: s, status: "ready", limit: 999 }).length;
  const posted = vdb.list({ shop: s, status: "posted", limit: 999 }).length;
  const prof = edb.getProfile(s);
  console.log(
    `${s.padEnd(30)} | SP tiềm năng: ${String(cand.candidates.length).padStart(3)} | video ready: ${String(ready).padStart(3)} | posted: ${posted} | kiki: ${prof ?? "CHƯA MAP"}`
  );
}

console.log(`\n=== MAP shop → Kiki profile hiện có ===`);
const all = edb.allProfiles();
if (!all.length) console.log("(chưa map shop nào)");
for (const p of all) console.log(`${p.shop.padEnd(30)} → ${p.kiki_profile}`);

tdb.close(); edb.close(); vdb.close();
