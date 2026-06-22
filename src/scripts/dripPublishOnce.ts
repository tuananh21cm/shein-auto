/**
 * Chạy TAY 1 cycle drip-publish (publish 1 draft/shop).
 *   npm run publish:drip
 * Dùng cookieUser từ config/publish.json.
 */
import "dotenv/config";
import { runDripCycle } from "../core/dripPublisher";
import { publishConfig } from "../config/appConfig";

async function main() {
  const cfg = publishConfig();
  console.log(`▶ Drip cycle (cookieUser=${cfg.cookieUser}, ${cfg.perShopPerCycle} draft/shop)…`);
  const r = await runDripCycle({
    cookieUser: cfg.cookieUser,
    perShopPerCycle: cfg.perShopPerCycle,
    interShopJitterSec: [cfg.interShopJitterMinSec, cfg.interShopJitterMaxSec],
    onLog: (m) => console.log(m),
  });
  console.log(`\n✅ Xong: publish ${r.published} sp · còn ~${r.remaining} draft.`);
  console.log("Theo shop:", JSON.stringify(r.perShop));
}
main().then(() => process.exit(0)).catch((e) => { console.error("LỖI:", e.message); process.exit(1); });
