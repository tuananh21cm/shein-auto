/** Probe nhanh cache agent-bridge (crm_sku_performance / crm_niche_performance / gate). */
import { getDb } from "../state/db";

const db = getDb();
const g = (s: string) => (db.prepare(s).get() as any)?.c;
console.log("sku_cache:", g("SELECT COUNT(*) c FROM crm_sku_performance"));
console.log("niche_cache:", g("SELECT COUNT(*) c FROM crm_niche_performance"));
console.log("gated:", g("SELECT COUNT(*) c FROM excluded_products WHERE reason='crm_high_refund'"));
console.log("top3_sku:", JSON.stringify(db.prepare(
  "SELECT goods_id, orders, margin_pct, effective_refund_rate_pct, risk, tier FROM crm_sku_performance ORDER BY orders DESC LIMIT 3"
).all()));
console.log("niches:", JSON.stringify(db.prepare(
  "SELECT niche, orders, orders_percent, refund_rate_pct, margin_pct FROM crm_niche_performance"
).all()));
