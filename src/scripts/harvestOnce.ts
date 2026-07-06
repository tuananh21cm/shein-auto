/**
 * Chạy TAY 1 cycle link-harvester (kéo link SHEIN về uncrawl cho shop uncrawl < threshold).
 *   npm run harvest
 * Chrome tự bật. Config: harvest.json.
 */
import "dotenv/config";
import { initDb, closeDb } from "../state/db";
import { runHarvestCycle } from "../core/linkHarvester";

async function main() {
  await initDb();
  const maxShops = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : undefined;
  const r = await runHarvestCycle({ maxShops, onLog: (m) => console.log(m) });
  console.log(`\n✅ Xong: ${r.shops} shop harvest · nạp ${r.inserted} link vào uncrawl.`);
  console.log("Theo shop:", JSON.stringify(r.perShop, null, 1));
  closeDb();
}
main().then(() => process.exit(0)).catch((e) => { console.error("LỖI:", e.message); process.exit(1); });
