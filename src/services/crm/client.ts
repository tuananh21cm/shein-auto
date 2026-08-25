/**
 * Client agent-bridge với KBT CRM (SWTCRM) — kênh 1 chiều DO SHEIN-AUTO KHỞI XƯỚNG
 * (máy local không có IP public, CRM không gọi ngược được):
 *
 *   GET  {url}/agent/sku-performance?days=N    — hiệu năng SKU thật (orders/margin/refund/tier)
 *   GET  {url}/agent/niche-performance?days=N  — demand nội bộ per niche (thay Kalodata)
 *   POST {url}/agent/listing-registry          — đẩy registry listing đã đăng lên CRM
 *
 * Auth: header `x-agent-secret` (env CRM_BRIDGE_SECRET ưu tiên, fallback config/crm.json).
 * URL: env CRM_BRIDGE_URL ưu tiên, fallback config/crm.json. Endpoint CRM fail-closed
 * (thiếu secret server → 503, sai → 401) — lỗi ở đây là lỗi NHÌN THẤY, không im lặng.
 */
import { crmConfig } from "../../config/appConfig";

export interface CrmSkuRow {
  goods_id: string;
  title: string;
  niche: string;
  orders: number;
  orders_prev_window: number;
  monthly_velocity: number | null;
  score: number | null;
  tier: string;
  refund_count: number;
  effective_refund_rate_pct: number | null;
  risk: "safe" | "medium" | "high" | string;
  fulfill_price: number | null;
  revenue_avg: number | null;
  margin_usd: number | null;
  margin_pct: number | null;
  has_oos: boolean;
  shops: string[];
}

export interface CrmNicheRow {
  niche: string;
  orders: number;
  orders_percent: number;
  refund_count: number;
  refund_rate_pct: number;
  revenue: number;
  cost: number;
  margin_pct: number;
}

export interface RegistryRow {
  goods_id: string;
  tiktok_product_id?: string;
  shop?: string;       // mã folder shein-auto (vd P5-034)
  shop_name?: string;  // tên shop TikTok trên 4Seller
  sku?: string;
  title?: string;
  price_listed?: string;
  publish_status?: string; // live | draft | failed
  listed_at?: string;      // ISO
}

export function crmBridgeSettings(): { enabled: boolean; url: string; secret: string } {
  const cfg = crmConfig();
  const url = (process.env.CRM_BRIDGE_URL || cfg.url || "").trim().replace(/\/+$/, "");
  const secret = (process.env.CRM_BRIDGE_SECRET || cfg.secret || "").trim();
  const enabledFlag = process.env.CRM_BRIDGE_ENABLED === "1" || Boolean(cfg.enabled);
  return { enabled: Boolean(enabledFlag && url && secret), url, secret };
}

async function crmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { enabled, url, secret } = crmBridgeSettings();
  if (!enabled) throw new Error("CRM bridge chưa cấu hình (config/crm.json enabled+url+secret)");
  const MAX_ATTEMPTS = 2;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000); // sku-performance quét pipeline — cho hẳn 90s
    try {
      const res = await fetch(`${url}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-agent-secret": secret,
          ...(init?.headers ?? {}),
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const body = (await res.json()) as T & { success?: boolean; error?: string };
        if ((body as any)?.success === false) throw new Error((body as any)?.error || "CRM trả success=false");
        return body;
      }
      // 401/503 = cấu hình sai — retry vô nghĩa, báo rõ luôn.
      if (res.status === 401) throw new Error("CRM từ chối: sai x-agent-secret (401)");
      if (res.status === 503) throw new Error("CRM chưa cấu hình AGENT_BRIDGE_SECRET (503)");
      lastErr = `HTTP ${res.status}`;
      if (attempt < MAX_ATTEMPTS && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`CRM ${path} → ${lastErr}`);
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        lastErr = "timeout 90s";
        if (attempt < MAX_ATTEMPTS) continue;
        throw new Error(`CRM ${path} → ${lastErr}`);
      }
      if (attempt >= MAX_ATTEMPTS || /từ chối|chưa cấu hình/.test(String(e?.message))) throw e;
      lastErr = e?.message ?? String(e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`CRM ${path} → ${lastErr || "thất bại sau retry"}`);
}

export async function fetchSkuPerformance(days = 30): Promise<{ window_days: number; rows: CrmSkuRow[] }> {
  const d = await crmFetch<{ window: { days: number }; rows: CrmSkuRow[] }>(
    `/agent/sku-performance?days=${days}`
  );
  return { window_days: d.window?.days ?? days, rows: d.rows ?? [] };
}

export async function fetchNichePerformance(days = 30): Promise<{ window_days: number; rows: CrmNicheRow[] }> {
  const d = await crmFetch<{ window: { days: number }; rows: CrmNicheRow[] }>(
    `/agent/niche-performance?days=${days}`
  );
  return { window_days: d.window?.days ?? days, rows: d.rows ?? [] };
}

/** Đẩy registry theo batch ≤500 rows/request (CRM cap 2000 — chừa dư). Trả tổng accepted/skipped. */
export async function pushListingRegistry(rows: RegistryRow[]): Promise<{ accepted: number; skipped: number }> {
  let accepted = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const d = await crmFetch<{ accepted: number; skipped: number }>(`/agent/listing-registry`, {
      method: "POST",
      body: JSON.stringify({ source: "shein-auto", rows: batch }),
    });
    accepted += d.accepted ?? 0;
    skipped += d.skipped ?? 0;
  }
  return { accepted, skipped };
}
