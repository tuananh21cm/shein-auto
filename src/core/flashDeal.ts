/**
 * flashDeal — auto tạo Flash Deal cho 1 shop từ tín hiệu view:
 *   candidates (top-view ∪ đang lên ∪ có đơn, né 7d-tăng-ít) ∩ sp đủ điều kiện flash (page-search)
 *   → build payload variation-level, giảm `discountPct`% mỗi sku → create/publish.
 * dryRun=true (mặc định): build + trả payload, KHÔNG publish.
 * Xem hợp đồng API: docs/4seller-flash-api.md
 */
import fs from "fs-extra";
import path from "path";
import cron from "node-cron";
import { getShopList, flashEligibleProducts, createFlashDeal } from "../services/fourseller/client";
import { resolveAccountForShop } from "../state/fourSellerAccounts";
import { TiktokDb } from "../services/tiktok/db";
import { scanPromotions } from "./promotionScan";
import { flashConfig } from "../config/appConfig";

export interface AutoFlashOptions {
  dryRun?: boolean;
  discountPct?: number;     // % off (mặc định 24)
  limit?: number;           // số sp tối đa khi có tín hiệu (mặc định 30)
  durationDays?: number;    // độ dài flash (mặc định 3 ngày)
  risingPerDay?: number;
  topViewPv?: number;
  /** Shop CHƯA có thống kê view → random trong khoảng này (mặc định 20–25). */
  randomMin?: number;
  randomMax?: number;
  onLog?: (m: string) => void;
}

export interface AutoFlashResult {
  shop: string; shopId: number; account: string;
  dryRun: boolean;
  mode: "signal" | "random-no-stats" | "random-no-signal";
  candidates: number;        // sp có tín hiệu (getFlashCandidates)
  eligible: number;          // sp đủ điều kiện flash (page-search)
  picked: number;            // sp đưa vào flash
  skuCount: number;          // tổng variation (sku) trong payload
  activityName: string;
  beginTime: number; endTime: number;
  sample: { productId: string; name: string; skus: number; origFirst: number; dealFirst: string }[];
  payload?: any;             // chỉ trả khi dryRun
  published?: boolean;
}

/** Trộn mảng (Fisher–Yates). Dùng cho shop chưa có thống kê view → chọn ngẫu nhiên. */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Giá deal cho 1 sku khi giảm pct% — LÀM TRÒN LÊN tới cent (ceil). Vì TikTok hiển thị %
 * theo ceil: round-nearest lỡ tròn xuống → discount 24.01% → TikTok show 25%. Ceil giữ
 * giá deal ≥ giá đúng → discount ≤ pct → hiển thị đúng pct%. Khớp cách 4Seller tính.
 */
export function flashDealPrice(originalPrice: number, pct: number): string {
  return (Math.ceil(originalPrice * (1 - pct / 100) * 100) / 100).toFixed(2);
}

const shortShop = (s: string) =>
  String(s).replace(/^T[AN] /, "").replace(/_US$/, "").replace(/Scan ?\d+\s*[-—]?\s*/, "").trim() || s;

export async function autoFlashDeal(shop: string, opts: AutoFlashOptions = {}): Promise<AutoFlashResult> {
  const log = opts.onLog ?? (() => {});
  const dryRun = opts.dryRun !== false;
  const pct = opts.discountPct ?? 24;
  const limit = opts.limit ?? 30;
  const durationDays = opts.durationDays ?? 3;

  // 1. Tài khoản 4Seller sở hữu shop + shopId
  const account = await resolveAccountForShop(shop);
  if (!account) throw new Error(`Shop "${shop}" không thuộc tài khoản 4Seller nào (tab Cookie 4Seller).`);
  const principal = `acct:${account.uid}`;
  const shopList = await getShopList(principal);
  const rec = (shopList?.records ?? []).find((s: any) => s.shopName === shop);
  if (!rec) throw new Error(`Không thấy shop "${shop}" trong 4Seller (tài khoản ${account.label}).`);
  const shopId = Number(rec.id);
  log(`[${shop}] shopId=${shopId} · tài khoản=${account.label}`);

  // 2. Khoảng thời gian flash (bắt đầu +2 phút, kéo durationDays ngày)
  const beginTime = Date.now() + 2 * 60_000;
  const endTime = beginTime + durationDays * 86_400_000;

  // 3. Candidates từ tín hiệu view
  const db = new TiktokDb();
  let cand;
  try {
    cand = db.getFlashCandidates(shop, { limit, risingPerDay: opts.risingPerDay, topViewPv: opts.topViewPv });
  } finally {
    db.close();
  }
  const rankById = new Map<string, number>(cand.candidates.map((c, i) => [String(c.productId), i]));
  log(`[${shop}] candidates (tín hiệu): ${cand.candidates.length}`);

  // 4. Sp đủ điều kiện flash (chưa nằm flash khác trong khoảng)
  const elig = await flashEligibleProducts(principal, { shopId, startTime: beginTime, endTime, pageSize: 100 });
  const records = elig?.records ?? [];
  log(`[${shop}] eligible (page-search): ${records.length}/${elig?.total ?? "?"}`);

  // 5. Chọn sp:
  //  - Shop CÓ thống kê view: giao (tín hiệu ∩ đủ điều kiện), ưu tiên theo rank candidate.
  //  - Shop CHƯA có thống kê (historyDays=0) hoặc không giao được sp nào: random randomMin–randomMax.
  const randomMin = opts.randomMin ?? 20;
  const randomMax = opts.randomMax ?? 25;
  const signalPicked = records
    .filter((r: any) => rankById.has(String(r.productId)))
    .sort((a: any, b: any) => (rankById.get(String(a.productId)) ?? 1e9) - (rankById.get(String(b.productId)) ?? 1e9))
    .slice(0, limit);
  let picked: any[];
  let mode: AutoFlashResult["mode"];
  if (cand.historyDays > 0 && signalPicked.length > 0) {
    picked = signalPicked; mode = "signal";
    log(`[${shop}] picked (tín hiệu ∩ đủ điều kiện, cap ${limit}): ${picked.length}`);
  } else {
    const n = Math.min(records.length, randomMin + Math.floor(Math.random() * (randomMax - randomMin + 1)));
    picked = shuffle(records).slice(0, n);
    mode = cand.historyDays === 0 ? "random-no-stats" : "random-no-signal";
    log(`[${shop}] picked (RANDOM ${mode === "random-no-stats" ? "chưa có thống kê view" : "có stats nhưng 0 tín hiệu"}): ${picked.length}/${records.length}`);
  }

  // 6. Build payload — mỗi sku giảm pct%.
  // GIÁ DEAL LÀM TRÒN LÊN (ceil to cents) — GIỐNG 4Seller. Vì TikTok hiển thị % theo kiểu
  // ceil: nếu round-nearest lỡ tròn xuống → discount 24.01% → TikTok show 25%. Ceil giữ
  // discount ≤ pct nên hiển thị đúng pct%. (vd 35.44×0.76=26.9344 → 26.94, KHÔNG phải 26.93)
  const dealPrice = (orig: number) => flashDealPrice(orig, pct);
  const products = picked.map((r: any) => ({
    ...r,
    skus: (r.skus ?? []).map((s: any) => ({
      ...s,
      hasAdd: 1,
      activityPriceAmountPercentage: String(pct),
      activityPriceAmount: dealPrice(Number(s.originalPrice)),
      discount: null,
    })),
  }));
  const skuCount = products.reduce((n: number, p: any) => n + (p.skus?.length ?? 0), 0);
  const date = new Date(beginTime).toISOString().slice(5, 10).replace("-", "/");
  const activityName = `FLASH ${shortShop(shop)} ${date} -${pct}%`.slice(0, 50);
  const payload = { shopId, shopCurrency: "", activityName, beginTime, endTime, discountType: "FLASHSALE", productLevel: "VARIATION", products };

  const sample = picked.slice(0, 5).map((r: any) => ({
    productId: String(r.productId), name: String(r.productName || "").slice(0, 40),
    skus: r.skus?.length ?? 0,
    origFirst: Number(r.skus?.[0]?.originalPrice ?? 0),
    dealFirst: dealPrice(Number(r.skus?.[0]?.originalPrice ?? 0)),
  }));

  const base: AutoFlashResult = {
    shop, shopId, account: account.label, dryRun, mode, candidates: cand.candidates.length,
    eligible: records.length, picked: picked.length, skuCount, activityName, beginTime, endTime, sample,
  };

  if (picked.length === 0) {
    log(`[${shop}] ⚠️ 0 sp đủ điều kiện (eligible=${records.length}) — không tạo flash.`);
    return { ...base, payload: dryRun ? payload : undefined };
  }

  if (dryRun) {
    log(`[${shop}] DRY-RUN [${mode}]: ${picked.length} sp · ${skuCount} variation · "${activityName}" · giảm ${pct}%`);
    return { ...base, payload };
  }

  log(`[${shop}] ▶ PUBLISH flash "${activityName}" [${mode}] (${picked.length} sp, ${skuCount} variation)…`);
  await createFlashDeal(principal, payload); // throw nếu 4Seller trả code!=0
  log(`[${shop}] ✅ Đã tạo flash.`);
  return { ...base, published: true };
}

/* ============= AUTO mọi shop: hết flash ~minGap phút → tạo flash mới ============= */

const FLASH_STATE_FILE = path.resolve(process.cwd(), "data", "_flash_auto_state.json");

/** {shopName: lastCreatedMs} — chống tạo trùng khi scan còn stale. */
async function loadFlashState(): Promise<Record<string, number>> {
  try { return await fs.readJson(FLASH_STATE_FILE); } catch { return {}; }
}
async function saveFlashState(s: Record<string, number>): Promise<void> {
  await fs.writeJson(FLASH_STATE_FILE, s, { spaces: 1 }).catch(() => {});
}

export interface AutoFlashAllOptions extends AutoFlashOptions {
  /** Chỉ tạo khi flash đã hết ≥ minGapMinutes phút (mặc định 20). */
  minGapMinutes?: number;
  /** Chống tạo lại 1 shop trong khoảng này (phút) — backstop khi scan stale (mặc định 90). */
  cooldownMinutes?: number;
  onlyShops?: string[];
}

/**
 * Quét promotion (sync tươi) → shop nào ĐANG hết flash (flashExpired) và flash cuối đã kết thúc
 * ≥ minGapMinutes phút (hoặc chưa từng có flash) → tạo flash mới. Tuần tự, guard cooldown.
 */
export async function autoFlashAllShops(opts: AutoFlashAllOptions = {}): Promise<{
  scanned: number; expired: number; eligible: number; created: number;
  results: { shop: string; ok: boolean; mode?: string; picked?: number; error?: string }[];
}> {
  const log = opts.onLog ?? ((m: string) => console.log("[flash-auto]", m));
  const cfg = flashConfig();
  const dryRun = opts.dryRun ?? false;
  const minGapMs = (opts.minGapMinutes ?? cfg.minGapMinutes ?? 20) * 60_000;
  const cooldownMs = (opts.cooldownMinutes ?? cfg.cooldownMinutes ?? 90) * 60_000;
  const now = Date.now();

  log(`▶ Scan promotion (sync) để tìm shop hết flash…`);
  const scan = await scanPromotions({ sync: true, onLog: (m) => log("  " + m) });
  const state = await loadFlashState();

  let rows = scan.rows.filter((r) => r.flashExpired);
  if (opts.onlyShops?.length) rows = rows.filter((r) => opts.onlyShops!.includes(r.shop));
  // đủ điều kiện: flash cuối đã hết ≥ minGap (hoặc chưa từng có flash) + qua cooldown
  const targets = rows.filter((r) => {
    const gapOk = r.lastFlashEnd == null || now - r.lastFlashEnd >= minGapMs;
    const cooled = now - (state[r.shop] ?? 0) >= cooldownMs;
    return gapOk && cooled;
  });
  log(`Scan: ${scan.rows.length} shop · ${rows.length} hết flash · ${targets.length} đủ điều kiện tạo (gap ≥${minGapMs / 60000}p, cooldown ${cooldownMs / 60000}p)${dryRun ? " · DRY-RUN" : ""}`);

  const results: { shop: string; ok: boolean; mode?: string; picked?: number; error?: string }[] = [];
  let created = 0;
  for (const r of targets) {
    try {
      const res = await autoFlashDeal(r.shop, {
        dryRun, discountPct: opts.discountPct ?? cfg.discountPct, limit: opts.limit ?? cfg.limit,
        durationDays: opts.durationDays ?? cfg.durationDays, randomMin: opts.randomMin ?? cfg.randomMin,
        randomMax: opts.randomMax ?? cfg.randomMax, onLog: log,
      });
      const ok = res.published === true || (dryRun && res.picked > 0);
      if (res.published) { state[r.shop] = now; created++; }
      results.push({ shop: r.shop, ok, mode: res.mode, picked: res.picked });
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 160);
      log(`✗ [${r.shop}] ${error}`);
      results.push({ shop: r.shop, ok: false, error });
    }
  }
  if (!dryRun) await saveFlashState(state);
  log(`🏁 Xong: tạo ${created}/${targets.length} flash.`);
  return { scanned: scan.rows.length, expired: rows.length, eligible: targets.length, created, results };
}

let flashTimer: ReturnType<typeof cron.schedule> | null = null;
let flashRunning = false;

/** Cron: mỗi intervalMinutes → autoFlashAllShops. Guard chạy 1 phiên/lần. */
export function scheduleFlashAuto(): void {
  const cfg = flashConfig();
  if (!cfg.enabled) { console.log("⏰ Flash-auto: TẮT (flash.json → enabled=false)"); return; }
  const iv = Math.max(5, cfg.intervalMinutes ?? 15);
  const expr = `*/${iv} * * * *`;
  if (!cron.validate(expr)) { console.error(`⏰ Flash-auto: lịch không hợp lệ ${expr}`); return; }
  flashTimer?.stop();
  flashTimer = cron.schedule(expr, async () => {
    if (flashRunning) { console.log("[flash-auto] vòng trước chưa xong — bỏ."); return; }
    flashRunning = true;
    try {
      const r = await autoFlashAllShops({ onLog: (m) => console.log("[flash-auto]", m) });
      console.log(`[flash-auto] ✓ ${r.created} flash mới / ${r.eligible} đủ điều kiện (${r.expired} hết flash).`);
    } catch (e: any) {
      console.error("[flash-auto] ✗", e?.message ?? e);
    } finally { flashRunning = false; }
  });
  console.log(`⏰ Flash-auto: BẬT (mỗi ${iv}p · hết flash ≥${cfg.minGapMinutes ?? 20}p → tạo flash -${cfg.discountPct ?? 24}%)`);
}
