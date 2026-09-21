/**
 * Màn "Vận hành" — Đợt 1: Sức khoẻ shop + Lãi lỗ SKU.
 *
 * Nguồn dữ liệu: ƯU TIÊN CRM KBT (agent bridge, header x-agent-secret) khi đã cấu hình secret,
 * không thì dùng dữ liệu local (snapshot TikCheck ở data/tikcrm/shops, bảng crm_sku_performance).
 * Mọi kết quả đều kèm `updatedAt` + `source` để UI ghi rõ "dữ liệu cập nhật X ngày trước" —
 * số cũ không được trông như số mới.
 *
 * Nối shop giữa các hệ thống: 4Seller `sellingPartnerId` == TikTok `shop_id` (đo 21/09: khớp 54/58 shop).
 */
import fs from "fs-extra";
import path from "path";
import { getShopList } from "../services/fourseller/client";
import { listAccounts } from "../state/fourSellerAccounts";
import { getDb } from "../state/db";

/* ───────────── CRM bridge (đọc config/crm.json, env ưu tiên) ───────────── */
export function crmSettings(): { enabled: boolean; url: string; secret: string; pullDays: number } {
  let cfg: any = {};
  try { cfg = fs.readJsonSync(path.resolve(process.cwd(), "config", "crm.json")); } catch { /* chưa có file = tắt */ }
  const url = String(process.env.CRM_BRIDGE_URL || cfg.url || "").trim().replace(/\/+$/, "");
  const secret = String(process.env.CRM_BRIDGE_SECRET || cfg.secret || "").trim();
  const on = process.env.CRM_BRIDGE_ENABLED === "1" || Boolean(cfg.enabled);
  return { enabled: Boolean(on && url && secret), url, secret, pullDays: Number(cfg.pullDays) || 30 };
}

async function crmGet<T>(p: string): Promise<T> {
  const s = crmSettings();
  if (!s.enabled) throw new Error("CRM chưa cấu hình (cần CRM_BRIDGE_SECRET)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${s.url}${p}`, { headers: { Accept: "application/json", "x-agent-secret": s.secret }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`CRM ${p} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

/* ───────────── Sức khoẻ shop ───────────── */
export type HealthLevel = "red" | "yellow" | "green" | "none";
export interface HealthRow {
  shop: string; account: string; tiktokName: string | null; shopCode: string | null;
  level: HealthLevel; status: string | null; severity: string | null; violationScore: number | null;
  net: number | null; onHold: number | null; reserve: number | null; totalHolding: number | null;
  restricted: number | null; orderLimit: string | null; activeListings: number | null; dailyOrders: number | null;
  updatedAt: string | null;
}
export interface HealthResult { rows: HealthRow[]; source: "crm" | "local"; builtAt: number; crmError?: string }

const num = (v: any): number | null => {
  const n = Number(v && typeof v === "object" && "amount" in v ? v.amount : v);
  return Number.isFinite(n) ? n : null;
};

/** Cùng logic phân loại với UI TikCRM cũ (nhánh draft) + shop_severity TikTok trả về. */
export function levelOf(p: any): HealthLevel {
  if (!p) return "none";
  const s = String(p.shop_status || "").toLowerCase();
  const sev = String(p.shop_severity || "").toLowerCase();
  if (sev === "terminal" || sev === "blocked" || /closed|đóng|terminat|deactiv|banned/.test(s)) return "red";
  if (sev === "warning" || (s && s !== "live") || Number(p.restricted_product_count) > 0) return "yellow";
  if (s === "live" || sev === "ok") return "green";
  return "none";
}

/** Snapshot local: shop_id TikTok → payload mới nhất (+ received_at). ~2000 file / 17MB. */
async function localHealthIndex(): Promise<Map<string, any>> {
  const dir = path.resolve(process.cwd(), "data", "tikcrm", "shops");
  const out = new Map<string, any>();
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (let i = 0; i < files.length; i += 100) {
    await Promise.all(files.slice(i, i + 100).map(async (f) => {
      try {
        const r = await fs.readJson(path.join(dir, f));
        const p = r?.payload || {};
        if (p.shop_id) out.set(String(p.shop_id), { ...p, _updatedAt: r.received_at ?? null });
      } catch { /* file hỏng → bỏ */ }
    }));
    await new Promise((r) => setImmediate(r)); // nhường event loop giữa các lô
  }
  return out;
}

/** CRM: GET /agent/shop-health → { shops: [{ shop_id, ...payload TikCheck, updated_at }] } (hợp đồng đề xuất). */
async function crmHealthIndex(): Promise<Map<string, any>> {
  const d = await crmGet<{ shops?: any[] }>("/agent/shop-health");
  const out = new Map<string, any>();
  for (const p of d.shops ?? []) if (p?.shop_id) out.set(String(p.shop_id), { ...p, _updatedAt: p.updated_at ?? null });
  return out;
}

async function buildHealth(): Promise<HealthResult> {
  let source: HealthResult["source"] = "local";
  let crmError: string | undefined;
  const loadIdx = async (): Promise<Map<string, any>> => {
    if (!crmSettings().enabled) return localHealthIndex();
    try { const m = await crmHealthIndex(); source = "crm"; return m; }
    catch (e: any) { crmError = String(e?.message ?? e).slice(0, 120); return localHealthIndex(); }
  };
  // Snapshot sức khoẻ và danh sách shop 4Seller (mỗi tài khoản) độc lập nhau → chạy song song.
  const accounts = await listAccounts();
  const [idx, lists] = await Promise.all([
    loadIdx(),
    Promise.all(accounts.map((acc) => getShopList(`acct:${acc.uid}`).then((r) => (r?.records ?? []) as any[], () => [] as any[]))),
  ]);

  const rows: HealthRow[] = [];
  for (const [i, acc] of accounts.entries()) {
    for (const s of lists[i]) {
      const p = idx.get(String(s.sellingPartnerId ?? ""));
      rows.push({
        shop: s.shopName, account: acc.label, tiktokName: p?.shop_name ?? s.platformShopName ?? null, shopCode: p?.shop_code ?? null,
        level: levelOf(p), status: p?.shop_status ?? null, severity: p?.shop_severity ?? null,
        violationScore: num(p?.violation_score), net: num(p?.net_earnings), onHold: num(p?.on_hold),
        reserve: num(p?.reserve), totalHolding: num(p?.total_holding), restricted: num(p?.restricted_product_count),
        orderLimit: p?.order_limit != null ? String(p.order_limit) : null, activeListings: num(p?.total_listings_active),
        dailyOrders: num(p?.daily_orders), updatedAt: p?._updatedAt ?? null,
      });
    }
  }
  const rank: Record<HealthLevel, number> = { red: 0, yellow: 1, none: 2, green: 3 };
  rows.sort((a, b) => rank[a.level] - rank[b.level] || (b.onHold ?? 0) - (a.onHold ?? 0) || a.shop.localeCompare(b.shop));
  return { rows, source, builtAt: Date.now(), crmError };
}

// Cache 10 phút + dùng chung 1 lần dựng cho người gọi đồng thời (dựng lạnh ~1-2s: 4Seller + đọc snapshot).
const HEALTH_TTL = 10 * 60_000;
let healthCache: HealthResult | null = null;
let healthInflight: Promise<HealthResult> | null = null;
export async function getShopHealth(force = false): Promise<HealthResult> {
  if (!force && healthCache && Date.now() - healthCache.builtAt < HEALTH_TTL) return healthCache;
  healthInflight ??= buildHealth().then((r) => (healthCache = r)).finally(() => { healthInflight = null; });
  return healthInflight;
}

/* ───────────── Lãi lỗ SKU ───────────── */
export interface SkuPnl { rows: any[]; fetchedAt: number | null; windowDays: number | null; crmEnabled: boolean }

export function getSkuPnl(): SkuPnl {
  const db = getDb();
  const rows = db.prepare(
    `SELECT goods_id, title, niche, orders, orders_prev, monthly_velocity, tier, refund_count,
            effective_refund_rate_pct, risk, fulfill_price, revenue_avg, margin_usd, margin_pct, has_oos, shops,
            fetched_at, window_days
       FROM crm_sku_performance`
  ).all() as any[];
  // Đọc mốc thời gian TRƯỚC khi dọn field khỏi từng dòng (rows[0] là cùng object với dòng đầu).
  const fetchedAt: number | null = rows[0]?.fetched_at ?? null;
  const windowDays: number | null = rows[0]?.window_days ?? null;
  for (const r of rows) {
    try { r.shops = JSON.parse(r.shops || "[]"); } catch { r.shops = []; }
    delete r.fetched_at; delete r.window_days;
  }
  return { rows, fetchedAt, windowDays, crmEnabled: crmSettings().enabled };
}

/** Kéo lại từ CRM (endpoint đã có sẵn: /agent/sku-performance?days=N) rồi thay toàn bộ bảng. */
export async function refreshSkuFromCrm(): Promise<number> {
  const days = crmSettings().pullDays;
  // Hình dạng response đúng như client cũ (nhánh draft) đã chạy thật: { window: { days }, rows }.
  const d = await crmGet<{ window?: { days?: number }; rows?: any[] }>(`/agent/sku-performance?days=${days}`);
  const list = (d.rows ?? []).filter((r) => /^\d{5,}$/.test(String(r.goods_id)));
  // CRM lỗi/trả rỗng thì GIỮ dữ liệu cũ — đừng để 1 lần gọi hỏng xoá sạch bảng.
  if (!list.length) throw new Error("CRM trả 0 SKU — giữ nguyên dữ liệu cũ");
  const windowDays = d.window?.days ?? days;
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO crm_sku_performance (
      goods_id, title, niche, orders, orders_prev, monthly_velocity, score, tier, refund_count,
      effective_refund_rate_pct, risk, fulfill_price, revenue_avg, margin_usd, margin_pct, has_oos, shops, window_days, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare("DELETE FROM crm_sku_performance").run();
    for (const r of list) ins.run(
      String(r.goods_id), r.title ?? "", r.niche ?? "", Number(r.orders) || 0, Number(r.orders_prev_window ?? r.orders_prev) || 0,
      r.monthly_velocity ?? null, r.score ?? null, r.tier ?? "", Number(r.refund_count) || 0, r.effective_refund_rate_pct ?? null,
      r.risk ?? "", r.fulfill_price ?? null, r.revenue_avg ?? null, r.margin_usd ?? null, r.margin_pct ?? null,
      r.has_oos ? 1 : 0, JSON.stringify(r.shops ?? []), windowDays, now
    );
  })();
  return list.length;
}
