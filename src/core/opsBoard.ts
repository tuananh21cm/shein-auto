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
import { getShopList, getListingPage } from "../services/fourseller/client";
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

export async function crmRequest<T>(p: string, body?: unknown): Promise<T> {
  const s = crmSettings();
  if (!s.enabled) throw new Error("CRM chưa cấu hình (cần CRM_BRIDGE_SECRET)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${s.url}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-agent-secret": s.secret },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CRM ${p} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}
const crmGet = <T>(p: string) => crmRequest<T>(p);

/* ───────────── Sức khoẻ shop ───────────── */
export type HealthLevel = "red" | "yellow" | "green" | "none";
export interface HealthRow {
  /** shop_id TikTok (= 4Seller sellingPartnerId) — khoá nối với dữ liệu CRM. */
  shopId: string;
  shop: string; account: string; tiktokName: string | null; shopCode: string | null;
  level: HealthLevel; status: string | null; severity: string | null; violationScore: number | null;
  net: number | null; onHold: number | null; reserve: number | null; totalHolding: number | null;
  restricted: number | null; orderLimit: string | null; activeListings: number | null; dailyOrders: number | null;
  /** Hạn mức ĐĂNG MỚI TikTok đặt cho shop (0/20/100/200/1000). Active có thể > limit khi TikTok hạ hạn mức sau này. */
  publishLimit: number | null; limitFrom: "crm" | "local" | null;
  /** TikTok "No limit" (publish_limit 0 + order_limit 999999) → publishLimit null, không bao giờ "đầy". */
  publishUnlimited: boolean;
  /** Số listing active: số THẬT từ 4Seller lúc dựng ("4seller"), lỗi thì số TikTok trong snapshot ("tiktok"). */
  activeFrom: "4seller" | "tiktok" | null;
  /** Tín hiệu "đừng đổ hàng vào shop này" — CRM bổ sung (payout_frozen / penalty_cluster_active). */
  payoutFrozen: boolean; penaltyCluster: boolean;
  /** Lãi lỗ 30 ngày (CRM /agent/shop-pnl, công thức trang Finance). null = CRM không có số / chưa nối. */
  pnl: { orders: number; revenue: number; cost: number; refund: number; net: number } | null;
  /** Số đơn sắp/đã bị phạt (CRM /agent/orders/at-risk). null = chưa nối CRM. */
  atRisk: number | null;
  updatedAt: string | null;
}
export interface RiskOrder { orderId: string; shopId: string; shop: string; kind: string; deadlineAt: number | null; hoursLeft: number | null; goodsId: string | null }
export interface HealthResult {
  rows: HealthRow[]; source: "crm" | "local"; builtAt: number; crmError?: string; riskOrders: RiskOrder[];
  /** Từng nguồn CRM phụ có lấy được không: null = chưa nối CRM, false = gọi lỗi. UI phải nói "CRM lỗi",
   *  KHÔNG được hiện như "không có đơn" / "không có lãi" (người xem sẽ tưởng mọi thứ ổn). */
  pnlOk: boolean | null; riskOk: boolean | null;
}

const isUnlimited = (p: any): boolean => !!p && Number(p.publish_limit) === 0 && Number(p.order_limit) >= 99999;

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
  // Lãi lỗ + đơn sắp phạt lấy CÙNG lượt dựng (song song) — dùng chung cache, khỏi gọi CRM riêng.
  const crmOn = crmSettings().enabled;
  const crmRows = (p: string) => (crmOn ? crmRequest<{ rows?: any[] }>(p).then((d) => d.rows ?? [], () => null) : Promise.resolve(null));
  const [idx, lists, pnlRows, riskRows] = await Promise.all([
    loadIdx(),
    Promise.all(accounts.map((acc) => getShopList(`acct:${acc.uid}`).then((r) => (r?.records ?? []) as any[], () => [] as any[]))),
    crmRows("/agent/shop-pnl?days=30&limit=2000"),
    crmRows("/agent/orders/at-risk?limit=2000"),
  ]);
  const pnlBy = new Map<string, any>((pnlRows ?? []).map((r: any) => [String(r.shop_id), r]));
  const riskBy = new Map<string, number>();
  for (const r of riskRows ?? []) riskBy.set(String(r.shop_id), (riskBy.get(String(r.shop_id)) ?? 0) + 1);

  // publish_limit: CRM chưa trả thì lấy từ snapshot local (hạn mức ít đổi). Chỉ đọc local khi thật sự thiếu.
  // (source được gán trong loadIdx — TS không thấy nên phải nới kiểu)
  const needLocal = (source as HealthResult["source"]) === "crm" && [...idx.values()].some((p) => !("publish_limit" in p));
  const localIdx = needLocal ? await localHealthIndex() : null;

  // Số active THẬT từ 4Seller (snapshot TikTok có thể cũ vài ngày → chặn nhầm shop vừa được dọn chỗ).
  // 6 luồng song song để không dội 4Seller.
  const live = new Map<number, number>();
  const jobs = accounts.flatMap((acc, i) => lists[i].map((s) => ({ P: `acct:${acc.uid}`, id: Number(s.id) })));
  for (let k = 0; k < jobs.length; k += 6) {
    await Promise.all(jobs.slice(k, k + 6).map(async (j) => {
      const t = (await getListingPage(j.P, { shopId: j.id, status: "active", pageSize: 1 }).catch(() => null))?.total;
      if (typeof t === "number") live.set(j.id, t);
    }));
  }

  const rows: HealthRow[] = [];
  for (const [i, acc] of accounts.entries()) {
    for (const s of lists[i]) {
      const p = idx.get(String(s.sellingPartnerId ?? ""));
      const own = p && "publish_limit" in p;
      const lp = own ? p : localIdx?.get(String(s.sellingPartnerId ?? ""));
      const sid = String(s.sellingPartnerId ?? "");
      const pr = pnlBy.get(sid);
      rows.push({
        shopId: sid,
        pnl: pr ? { orders: Number(pr.orders) || 0, revenue: Number(pr.revenue_usd) || 0, cost: Number(pr.cost_usd) || 0, refund: Number(pr.refund_usd) || 0, net: Number(pr.net_usd) || 0 } : null,
        atRisk: riskRows ? riskBy.get(sid) ?? 0 : null,
        shop: s.shopName, account: acc.label, tiktokName: p?.shop_name ?? s.platformShopName ?? null, shopCode: p?.shop_code ?? null,
        level: levelOf(p), status: p?.shop_status ?? null, severity: p?.shop_severity ?? null,
        violationScore: num(p?.violation_score), net: num(p?.net_earnings), onHold: num(p?.on_hold),
        reserve: num(p?.reserve), totalHolding: num(p?.total_holding), restricted: num(p?.restricted_product_count),
        orderLimit: p?.order_limit != null ? String(p.order_limit) : null,
        activeListings: live.get(Number(s.id)) ?? num(p?.total_listings_active),
        activeFrom: live.has(Number(s.id)) ? "4seller" : p?.total_listings_active != null ? "tiktok" : null,
        payoutFrozen: p?.payout_frozen === true, penaltyCluster: p?.penalty_cluster_active === true,
        dailyOrders: num(p?.daily_orders), updatedAt: p?._updatedAt ?? null,
        // TikTok "No limit": TikCheck/CRM trả publish_limit=0 KÈM order_limit=999999 (đo 25/09 trên CRM:
        // 124/127 shop limit 0 là kiểu này, vd AMONG.Stores 476 active). Trước hiểu là "khoá đăng mới"
        // (0/0) → chặn oan Calmwell 412 active, RUTMAN 155 active. limit 0 + order_limit thường = khoá thật.
        publishLimit: isUnlimited(lp) ? null : num(lp?.publish_limit), publishUnlimited: isUnlimited(lp),
        limitFrom: lp && lp.publish_limit != null ? (own ? source : "local") : null,
      });
    }
  }
  const rank: Record<HealthLevel, number> = { red: 0, yellow: 1, none: 2, green: 3 };
  rows.sort((a, b) => rank[a.level] - rank[b.level] || (b.onHold ?? 0) - (a.onHold ?? 0) || a.shop.localeCompare(b.shop));
  // Chỉ giữ đơn của shop MÌNH (CRM trả toàn hệ thống).
  const nameOf = new Map(rows.map((r) => [r.shopId, r.shop]));
  const riskOrders: RiskOrder[] = (riskRows ?? []).filter((r: any) => nameOf.has(String(r.shop_id))).map((r: any) => ({
    orderId: String(r.order_id), shopId: String(r.shop_id), shop: nameOf.get(String(r.shop_id))!, kind: String(r.kind),
    deadlineAt: r.deadline_at ? Date.parse(r.deadline_at) : null, hoursLeft: r.hours_left ?? null, goodsId: r.goods_id ?? null,
  }));
  return { rows, source, builtAt: Date.now(), crmError, riskOrders, pnlOk: crmOn ? pnlRows !== null : null, riskOk: crmOn ? riskRows !== null : null };
}

// Cache 10 phút + dùng chung 1 lần dựng cho người gọi đồng thời (dựng lạnh ~1-2s: 4Seller + đọc snapshot).
const HEALTH_TTL = 10 * 60_000;
let healthCache: HealthResult | null = null;
let healthInflight: Promise<HealthResult> | null = null;
const rebuildHealth = () => (healthInflight ??= buildHealth().then((r) => (healthCache = r)).finally(() => { healthInflight = null; }));
/** Có cache thì trả NGAY (cũ quá TTL thì làm mới ở nền) → queue/drip không bao giờ đứng chờ dựng lại. */
// Lần dựng có nguồn CRM bị lỗi (thường chỉ chập chờn mạng) chỉ giữ 1 phút rồi thử lại, không giữ đủ 10 phút.
const ttlOf = (h: HealthResult) => (h.crmError || h.pnlOk === false || h.riskOk === false ? 60_000 : HEALTH_TTL);
export async function getShopHealth(force = false): Promise<HealthResult> {
  if (force || !healthCache) return rebuildHealth();
  if (Date.now() - healthCache.builtAt >= ttlOf(healthCache)) void rebuildHealth().catch(() => {});
  return healthCache;
}

/** Không bao giờ chờ: có cache thì trả (cũ thì làm mới ở nền), chưa có thì kích dựng ở nền và trả null.
 *  Dùng cho màn cần tải nhanh (Listings) — thà thiếu số hạn mức một lượt còn hơn bắt người dùng chờ ~8s. */
export function peekShopHealth(): HealthResult | null {
  if (!healthCache || Date.now() - healthCache.builtAt >= ttlOf(healthCache)) void rebuildHealth().catch(() => {});
  return healthCache;
}

/** Lý do KHÔNG nên đổ hàng vào shop (null = đổ được). Dùng chung cho queue, drip, auto-source. */
export function blockReason(r: HealthRow): string | null {
  // KHÔNG chặn theo payout_frozen: CRM gắn cờ này cho MỌI shop severity blocked/terminal (kể cả
  // on_hold $0), mà shop "Order penalties" vẫn đăng được — đo 21/09: 20 listing đổ vào 654
  // (payout_frozen=true) lên 4 active + 12 đang duyệt. Chặn theo cờ này sẽ ngừng oan 18 shop.
  // Cờ vẫn hiện làm nhãn cảnh báo trên màn Vận hành.
  if (r.penaltyCluster) return "shop đang dính đợt phạt huỷ đơn";
  if (r.publishLimit === 0) return "TikTok khoá đăng mới (hạn mức 0)";
  if (r.publishLimit != null && r.activeListings != null && r.activeListings >= r.publishLimit)
    return `hết hạn mức listing (${r.activeListings}/${r.publishLimit})`;
  return null;
}

const normShop = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** shop (chuẩn hoá tên) → lý do chặn. Lỗi dựng dữ liệu thì trả map rỗng (không chặn gì — an toàn). */
export async function shopBlockMap(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try { for (const r of (await getShopHealth()).rows) { const why = blockReason(r); if (why) m.set(normShop(r.shop), why); } }
  catch { /* không có dữ liệu → không chặn */ }
  return m;
}
export const isShopBlocked = (m: Map<string, string>, shop: string) => m.get(normShop(shop)) ?? null;
/** Tra 1 dòng sức khoẻ theo tên shop/folder (chuẩn hoá giống bộ chặn). */
export const healthIndexByName = (h: HealthResult) => { const m = new Map<string, HealthRow>(); for (const r of h.rows) m.set(normShop(r.shop), r); return (shop: string) => m.get(normShop(shop)) ?? null; };

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
