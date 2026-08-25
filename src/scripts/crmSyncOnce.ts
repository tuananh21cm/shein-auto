/**
 * Chạy tay agent-bridge với KBT CRM (không chờ cron):
 *   npx tsx src/scripts/crmSyncOnce.ts pull       — pull sku+niche performance → cache + gate refund
 *   npx tsx src/scripts/crmSyncOnce.ts snapshot   — quét listing 4Seller → push registry
 *   npx tsx src/scripts/crmSyncOnce.ts both
 *
 * Yêu cầu: config/crm.json enabled=true + url + secret (hoặc env CRM_BRIDGE_URL/CRM_BRIDGE_SECRET).
 */
import { initDb } from "../state/db";
import { runCrmPullOnce, pushRegistrySnapshotOnce } from "../core/crmSync";
import { crmBridgeSettings } from "../services/crm/client";

const main = async () => {
  const mode = (process.argv[2] ?? "pull").toLowerCase();
  await initDb();
  const s = crmBridgeSettings();
  console.log(`Bridge: enabled=${s.enabled} url=${s.url}`);
  if (!s.enabled) {
    console.error("⛔ Bridge chưa cấu hình — sửa config/crm.json (enabled/url/secret) hoặc set env.");
    process.exit(1);
  }
  if (mode === "pull" || mode === "both") {
    const r = await runCrmPullOnce();
    console.log("PULL:", JSON.stringify(r));
  }
  if (mode === "snapshot" || mode === "both") {
    const r = await pushRegistrySnapshotOnce();
    console.log("SNAPSHOT:", JSON.stringify(r));
  }
  process.exit(0);
};
main().catch((e) => { console.error("✗", e?.message ?? e); process.exit(1); });
