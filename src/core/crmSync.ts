/**
 * crmSync — vòng phản hồi dữ liệu 2 chiều với KBT CRM (agent bridge, 2026-08-07).
 *
 * PULL (cron mỗi refreshHours, mặc định 12h):
 *   1. GET /agent/sku-performance   → cache `crm_sku_performance` (thay toàn bộ).
 *   2. GET /agent/niche-performance → cache `crm_niche_performance` (demand nội bộ,
 *      thay Kalodata đã bỏ — demandFromCrm.ts đọc bảng này).
 *   3. GATE refund: SKU đủ mẫu (orders >= gate.minOrders) và effective refund vượt
 *      gate.maxEffectiveRefundPct → INSERT excluded_products reason 'crm_high_refund'
 *      → autoCrawler/linkHarvester/dailyResearch tự né (cùng cơ chế loại kids/pack).
 *      SKU hồi phục (refund tụt dưới ngưỡng ở lần pull sau) → GỠ khỏi excluded (chỉ gỡ
 *      đúng reason 'crm_high_refund', không đụng exclusion tay/kids/pack).
 *
 * PUSH registry:
 *   - Event: queueManager gọi `pushRegistryForListingJson` NGAY sau publish thành công
 *     (fire-and-forget) — nguồn goods_id chuẩn nhất (variant_ids trong JSON gốc).
 *   - Snapshot: cron 1 lần/ngày (registry.snapshotHour) quét getListingPage mọi shop
 *     4Seller → bắt cả listing đăng tay + bổ sung tiktok_product_id. goods_id extract
 *     từ msku (msku = goods_id Shein per màu, có thể kèm suffix -SHOP — xem
 *     fillTableData.ts). Row không moi được goods_id → bỏ + LOG tỉ lệ (no silent drop).
 */
import cron, { type ScheduledTask } from "node-cron";
import { getDb } from "../state/db";
import { crmConfig } from "../config/appConfig";
import {
  crmBridgeSettings,
  fetchSkuPerformance,
  fetchNichePerformance,
  pushListingRegistry,
  type RegistryRow,
} from "../services/crm/client";
import { listAccounts } from "../state/fourSellerAccounts";
import { getShopList, getListingPage } from "../services/fourseller/client";

const GATE_REASON = "crm_high_refund";

const ensureExcludedTable = (db: any) =>
  db.exec(`CREATE TABLE IF NOT EXISTS excluded_products (goods_id TEXT PRIMARY KEY, reason TEXT, excluded_at INTEGER)`);

/* ───────────────────────── PULL: cache + gate ───────────────────────── */

export interface CrmPullResult {
  skus: number;
  niches: number;
  gated: number;     // SKU mới bị chặn vì refund cao
  ungated: number;   // SKU được gỡ chặn (refund hồi phục)
}

export async function runCrmPullOnce(onLog?: (m: string) => void): Promise<CrmPullResult> {
  const log = onLog ?? ((m: string) => console.log("[crm-sync]", m));
  const cfg = crmConfig();
  const days = Math.max(7, Math.min(120, cfg.pullDays ?? 30));

  log(`▶ Pull hiệu năng CRM (window ${days} ngày)…`);
  const [sku, niche] = await Promise.all([fetchSkuPerformance(days), fetchNichePerformance(days)]);

  const db = getDb();
  ensureExcludedTable(db);
  const now = Date.now();

  const insSku = db.prepare(`
    INSERT INTO crm_sku_performance (
      goods_id, title, niche, orders, orders_prev, monthly_velocity, score, tier,
      refund_count, effective_refund_rate_pct, risk, fulfill_price, revenue_avg,
      margin_usd, margin_pct, has_oos, shops, window_days, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insNiche = db.prepare(`
    INSERT INTO crm_niche_performance (
      niche, orders, orders_percent, refund_count, refund_rate_pct,
      revenue, cost, margin_pct, window_days, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM crm_sku_performance").run();
    for (const r of sku.rows) {
      if (!/^\d{5,}$/.test(String(r.goods_id))) continue;
      insSku.run(
        String(r.goods_id), r.title ?? "", r.niche ?? "",
        Number(r.orders) || 0, Number(r.orders_prev_window) || 0,
        r.monthly_velocity ?? null, r.score ?? null, r.tier ?? "",
        Number(r.refund_count) || 0, r.effective_refund_rate_pct ?? null,
        r.risk ?? "", r.fulfill_price ?? null, r.revenue_avg ?? null,
        r.margin_usd ?? null, r.margin_pct ?? null, r.has_oos ? 1 : 0,
        JSON.stringify(r.shops ?? []), sku.window_days, now
      );
    }
    db.prepare("DELETE FROM crm_niche_performance").run();
    for (const n of niche.rows) {
      insNiche.run(
        n.niche ?? "", Number(n.orders) || 0, n.orders_percent ?? null,
        Number(n.refund_count) || 0, n.refund_rate_pct ?? null,
        n.revenue ?? null, n.cost ?? null, n.margin_pct ?? null,
        niche.window_days, now
      );
    }
  })();

  // ── Gate refund cao ──
  let gated = 0;
  let ungated = 0;
  const gateCfg = cfg.gate ?? {};
  if (gateCfg.enabled !== false) {
    const minOrders = gateCfg.minOrders ?? 15;
    const maxPct = gateCfg.maxEffectiveRefundPct ?? 20;
    const insEx = db.prepare(
      "INSERT OR IGNORE INTO excluded_products (goods_id, reason, excluded_at) VALUES (?, ?, ?)"
    );
    const delEx = db.prepare(
      "DELETE FROM excluded_products WHERE goods_id = ? AND reason = ?"
    );
    db.transaction(() => {
      for (const r of sku.rows) {
        const gid = String(r.goods_id);
        if (!/^\d{5,}$/.test(gid)) continue;
        const pct = r.effective_refund_rate_pct;
        const bad = Number(r.orders) >= minOrders && pct != null && pct > maxPct;
        if (bad) {
          if (insEx.run(gid, GATE_REASON, now).changes > 0) gated++;
        } else {
          // chỉ gỡ chặn của CHÍNH gate này — refund đã hồi phục dưới ngưỡng
          if (delEx.run(gid, GATE_REASON).changes > 0) ungated++;
        }
      }
    })();
  }

  log(`✅ Cache: ${sku.rows.length} SKU · ${niche.rows.length} niche · gate refund: +${gated} chặn / -${ungated} gỡ`);
  return { skus: sku.rows.length, niches: niche.rows.length, gated, ungated };
}

/* ───────────── Helpers đọc cache (cho flashDeal / demandFit / enrich) ───────────── */

export interface CrmSkuCacheRow {
  goods_id: string; niche: string; orders: number; margin_pct: number | null;
  effective_refund_rate_pct: number | null; risk: string; tier: string;
}

/** Map goods_id → hiệu năng CRM. Rỗng nếu chưa từng pull. */
export function loadCrmSkuMap(): Map<string, CrmSkuCacheRow> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT goods_id, niche, orders, margin_pct, effective_refund_rate_pct, risk, tier
     FROM crm_sku_performance`
  ).all() as CrmSkuCacheRow[];
  return new Map(rows.map((r) => [String(r.goods_id), r]));
}

/** Extract goods_id Shein từ msku 4Seller ("12345678" / "12345678-SHOP" / random cũ → null). */
export function goodsIdFromMsku(msku: unknown): string | null {
  const m = String(msku ?? "").trim().match(/^(\d{7,11})(?:[-_].*)?$/);
  return m ? m[1] : null;
}

/* ───────────────────────── PUSH registry ───────────────────────── */

/**
 * Event push sau khi 1 listing publish thành công (gọi từ queueManager, fire-and-forget).
 * data = JSON listing gốc (variant_ids = [{color: goodsId}]).
 */
export async function pushRegistryForListingJson(
  data: any,
  folderName: string,
  profile: string
): Promise<void> {
  const { enabled } = crmBridgeSettings();
  if (!enabled || crmConfig().registry?.enabled === false) return;
  try {
    const gids = new Set<string>();
    for (const entry of data?.variant_ids ?? []) {
      for (const v of Object.values(entry ?? {})) {
        const gid = goodsIdFromMsku(v);
        if (gid) gids.add(gid);
      }
    }
    if (gids.size === 0) return;
    const nowIso = new Date().toISOString();
    const rows: RegistryRow[] = [...gids].map((gid) => ({
      goods_id: gid,
      shop: folderName,
      shop_name: profile,
      sku: gid,
      title: String(data?.product_name ?? "").slice(0, 400),
      publish_status: "live",
      listed_at: nowIso,
    }));
    const r = await pushListingRegistry(rows);
    console.log(`[crm-registry] event push ${folderName}: ${r.accepted} rows → CRM`);
  } catch (e: any) {
    console.warn(`[crm-registry] event push lỗi (bỏ qua, snapshot cron sẽ bù):`, e?.message ?? e);
  }
}

export interface RegistrySnapshotResult {
  accounts: number; shops: number; listings: number; withGoodsId: number; pushed: number; skippedNoGid: number;
}

/**
 * Snapshot cron: quét toàn bộ listing active mọi shop 4Seller → push registry.
 * Bắt được listing đăng tay + gắn tiktok_product_id (event push không có).
 */
export async function pushRegistrySnapshotOnce(onLog?: (m: string) => void): Promise<RegistrySnapshotResult> {
  const log = onLog ?? ((m: string) => console.log("[crm-registry]", m));
  const res: RegistrySnapshotResult = { accounts: 0, shops: 0, listings: 0, withGoodsId: 0, pushed: 0, skippedNoGid: 0 };
  const { enabled } = crmBridgeSettings();
  if (!enabled || crmConfig().registry?.enabled === false) { log("bridge tắt — bỏ snapshot"); return res; }

  const accounts = await listAccounts();
  res.accounts = accounts.length;
  const nowIso = new Date().toISOString();
  const rows: RegistryRow[] = [];

  for (const acc of accounts) {
    const principal = `acct:${acc.uid}`;
    let shops: { id: number; shopName: string }[] = [];
    try {
      const list = await getShopList(principal);
      shops = (list?.records ?? [])
        .filter((s: any) => !s.platform || /tiktok/i.test(String(s.platform)))
        .map((s: any) => ({ id: Number(s.id), shopName: String(s.shopName) }));
    } catch (e: any) {
      log(`⚠️ [${acc.label}] getShopList lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
      continue;
    }
    for (const shop of shops) {
      res.shops++;
      const MAX_PAGES = 10; // 10×100 = 1000 listing/shop — trần an toàn, log nếu còn nữa
      let page = 1;
      let total = 0;
      try {
        for (; page <= MAX_PAGES; page++) {
          const d = await getListingPage(principal, { shopId: shop.id, status: "active", pageCurrent: page, pageSize: 100 });
          const records = d?.records ?? [];
          total = Number(d?.total ?? records.length);
          for (const rec of records) {
            res.listings++;
            const gid = extractGoodsIdFromListingRecord(rec);
            if (!gid) { res.skippedNoGid++; continue; }
            res.withGoodsId++;
            rows.push({
              goods_id: gid,
              tiktok_product_id: String((rec as any).productId ?? ""),
              shop_name: shop.shopName,
              sku: gid,
              title: String((rec as any).title ?? (rec as any).productName ?? "").slice(0, 400),
              publish_status: "live",
              listed_at: nowIso,
            });
          }
          if (records.length < 100) break;
        }
        if (page > MAX_PAGES && total > MAX_PAGES * 100) {
          log(`⚠️ [${shop.shopName}] cắt ở ${MAX_PAGES * 100}/${total} listing (nâng MAX_PAGES nếu cần đủ)`);
        }
      } catch (e: any) {
        log(`⚠️ [${shop.shopName}] getListingPage lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, 800)); // nhịp giữa các shop — không dội 4Seller
    }
  }

  if (rows.length > 0) {
    const pushRes = await pushListingRegistry(rows);
    res.pushed = pushRes.accepted;
  }
  log(`✅ Snapshot: ${res.shops} shop · ${res.listings} listing · ${res.withGoodsId} có goods_id (bỏ ${res.skippedNoGid} không moi được msku) · pushed ${res.pushed}`);
  return res;
}

/** Moi goods_id từ 1 ListingRecord — thử các vị trí msku phổ biến (record flexible). */
export function extractGoodsIdFromListingRecord(rec: any): string | null {
  const direct = goodsIdFromMsku(rec?.msku ?? rec?.sellerSku ?? rec?.sku);
  if (direct) return direct;
  const arrays = [rec?.skus, rec?.skuList, rec?.mskus, rec?.variations];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const gid = goodsIdFromMsku(typeof s === "string" ? s : s?.msku ?? s?.sellerSku ?? s?.sku);
      if (gid) return gid;
    }
  }
  return null;
}

/* ───────────────────────── Scheduler ───────────────────────── */

let pullTimer: NodeJS.Timeout | null = null;
let pullRunning = false;
let snapshotTask: ScheduledTask | null = null;

export function scheduleCrmSync(): void {
  const cfg = crmConfig();
  const { enabled } = crmBridgeSettings();
  if (!enabled) {
    console.log("⏰ CRM bridge: TẮT (config/crm.json → enabled/url/secret chưa đủ)");
    return;
  }
  const hours = Math.max(1, Math.min(48, cfg.refreshHours ?? 12));

  const tick = async () => {
    if (pullRunning) return;
    pullRunning = true;
    try { await runCrmPullOnce(); }
    catch (e: any) { console.error("[crm-sync] ✗", e?.message ?? e); }
    finally { pullRunning = false; }
    pullTimer = setTimeout(tick, hours * 3600_000);
  };
  pullTimer = setTimeout(tick, 30_000); // lần đầu sau 30s boot

  const hour = Math.max(0, Math.min(23, cfg.registry?.snapshotHour ?? 4));
  snapshotTask?.stop();
  snapshotTask = cron.schedule(`15 ${hour} * * *`, async () => {
    try { await pushRegistrySnapshotOnce(); }
    catch (e: any) { console.error("[crm-registry] ✗ snapshot:", e?.message ?? e); }
  });

  console.log(`⏰ CRM bridge: BẬT (pull mỗi ${hours}h · registry snapshot ${hour}:15 hằng ngày)`);
}

export function stopCrmSync(): void {
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = null;
  snapshotTask?.stop();
  snapshotTask = null;
}
