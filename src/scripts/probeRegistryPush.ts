/** Smoke test push registry shein-auto → CRM (row test, xoá tay sau bên CRM). */
import { pushListingRegistry } from "../services/crm/client";

const main = async () => {
  const r = await pushListingRegistry([
    {
      goods_id: "100540586",
      tiktok_product_id: "",
      shop: "SMOKE-TEST",
      shop_name: "SMOKE-TEST-SHOP",
      sku: "100540586",
      title: "smoke test row - delete me",
      publish_status: "draft",
      listed_at: new Date().toISOString(),
    },
  ]);
  console.log("PUSH:", JSON.stringify(r));
  process.exit(0);
};
main().catch((e) => { console.error("✗", e?.message ?? e); process.exit(1); });
