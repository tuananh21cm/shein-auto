/**
 * dailyReport — report tổng hợp HẰNG NGÀY gửi vào kênh Telegram RIÊNG (DAILY_REPORT_TG_CHAT_ID).
 * Cron mặc định 8:00 sáng VN (DAILY_REPORT_CRON để đổi). Nội dung 7 mục:
 *   1. Listing: tổng active/shop (4Seller) + Δ so snapshot hôm qua + số list thành công hôm qua (history)
 *   2. Video: đăng hôm qua vs hôm kia + tổng đã đăng + đang chờ, per shop (videos.db)
 *   3. Đơn hôm qua per shop (4Seller sales — LƯU Ý gom theo ngày US)
 *   4. Danh sách shop HẾT flash (promo scan)
 *   5. Shop có >10 sp chưa chạy discount (promo scan)
 *   6. Shop có sp Low Stock (≤20) / Hết hàng (=0) — tiktok.db listing_views, run mới nhất
 *   7. Số đơn overdue per shop — tiktok.db metrics (action_shipping_overdue), run mới nhất
 *
 * Mỗi mục gather ĐỘC LẬP try/catch — 1 nguồn chết (cookie 4Seller, chưa crawl TikTok…)
 * thì mục đó hiện ⚠️, các mục khác vẫn gửi. Snapshot ngày lưu bảng daily_report_snapshot
 * (shein-auto.db) để tính Δ listing so hôm qua (4Seller chỉ có current-state).
 */
import cron, { type ScheduledTask } from "node-cron";
import axios from "axios";
import fs from "fs-extra";
import path from "path";
import Database from "better-sqlite3";
import { getDb } from "../state/db";
import { VideoDb } from "../state/videoDb";
import { chunkText } from "../services/tiktok/notifyReport";
import { getLastPromoScan, runAndStorePromoScan, type PromotionScanResult } from "./promotionScan";
import { listAccounts } from "../state/fourSellerAccounts";
import { getShopList, getSalesByShop } from "../services/fourseller/client";

const TG_API = "https://api.telegram.org";
const TIKTOK_DB = path.resolve(process.cwd(), "data", "tiktok.db");
const LOW_STOCK_AT = 20;          // sp có stock ≤ ngưỡng này = Low Stock (khớp dashboard TikTok)
const UNCOVERED_ALERT_AT = 10;    // shop có > N sp chưa discount thì vào danh sách cảnh báo
const PROMO_MAX_AGE_MS = 3 * 3600e3; // promo scan cũ hơn 3h → tự scan lại (cron promo chạy mỗi 2h)

let running = false;
let task: ScheduledTask | null = null;

/* ============= Config ============= */

function reportTgConfig(): { token: string; chatId: string } | null {
  const token = process.env.DAILY_REPORT_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.DAILY_REPORT_TG_CHAT_ID || "";
  if (!token || !chatId) return null;
  return { token, chatId };
}

/* ============= Helper ngày (giờ VN) ============= */

const vnDay = (offsetDays = 0): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 864e5));
const vnMidnight = (day: string): number => Date.parse(day + "T00:00:00+07:00");
const fmtDM = (day: string): string => day.slice(5).split("-").reverse().join("/");
const fmtTs = (ms: number): string =>
  new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

const shortShop = (s: string): string =>
  String(s).replace(/^T[AN] /, "").replace(/_US$/, "").trim() || s;
const lc = (s: string): string => String(s).toLowerCase().trim();
const money = (n: number): string => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const sign = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/* ============= Gather từng mục ============= */

interface ShopVideoStat { shop: string; totalPosted: number; ready: number; postedYesterday: number; postedDayBefore: number; }
interface ShopStockStat { shop: string; runDate: string; low: number; outOf: number; outNames: string[]; }
interface ShopOverdueStat { shop: string; runDate: string; overdue: number; }

export interface DailyReportData {
  today: string;    // YYYY-MM-DD giờ VN
  yesterday: string;
  promo: PromotionScanResult | null;
  promoErr?: string;
  /** folder(=shop) → số listing SUCCESS hôm qua (bảng history). */
  newListedYesterday: Map<string, number>;
  newListedErr?: string;
  /** lc(shop) → active_listings snapshot HÔM QUA (tính Δ). */
  snapYesterday: Map<string, number>;
  videos: ShopVideoStat[];
  videosErr?: string;
  /** shopName 4Seller → đơn/doanh thu hôm qua. */
  orders: Map<string, { orders: number; revenue: number }>;
  ordersErr?: string;
  stock: ShopStockStat[];
  stockErr?: string;
  overdue: ShopOverdueStat[];
  overdueErr?: string;
}

async function gatherData(log: (m: string) => void): Promise<DailyReportData> {
  const today = vnDay(0);
  const yesterday = vnDay(1);
  const tStart = vnMidnight(today);
  const yStart = vnMidnight(yesterday);
  const y2Start = yStart - 864e5;

  const d: DailyReportData = {
    today, yesterday,
    promo: null,
    newListedYesterday: new Map(),
    snapYesterday: new Map(),
    videos: [],
    orders: new Map(),
    stock: [],
    overdue: [],
  };

  // 1. Promo scan (flash + discount + activeListings) — dùng scan gần nhất, cũ quá thì scan lại
  try {
    d.promo = await getLastPromoScan();
    const age = d.promo ? Date.now() - d.promo.scannedAt : Infinity;
    if (age > PROMO_MAX_AGE_MS) {
      log(`Promo scan cũ ${Math.round(age / 3600e3)}h → scan lại…`);
      d.promo = await runAndStorePromoScan({ sync: true, onLog: log }).catch((e) => {
        log(`⚠️ Scan lại lỗi (${e?.message}) — dùng data cũ.`);
        return d.promo;
      });
    }
    if (!d.promo) d.promoErr = "Chưa có promo scan nào (chưa upload cookie 4Seller?)";
  } catch (e: any) {
    d.promoErr = String(e?.message ?? e);
  }

  // 2. Listing SUCCESS hôm qua per shop (bảng history, folder = shop)
  try {
    const rows = getDb().prepare(
      `SELECT folder, COUNT(*) c FROM history WHERE status='success' AND finished_at >= ? AND finished_at < ? GROUP BY folder`
    ).all(yStart, tStart) as { folder: string; c: number }[];
    for (const r of rows) d.newListedYesterday.set(lc(r.folder), r.c);
  } catch (e: any) {
    d.newListedErr = String(e?.message ?? e);
  }

  // 3. Video per shop (videos.db)
  try {
    const vdb = new VideoDb();
    try {
      d.videos = (vdb.db.prepare(
        `SELECT shop,
                SUM(status='posted') totalPosted,
                SUM(status='ready') ready,
                SUM(status='posted' AND posted_at >= ? AND posted_at < ?) postedYesterday,
                SUM(status='posted' AND posted_at >= ? AND posted_at < ?) postedDayBefore
         FROM videos GROUP BY shop ORDER BY shop`
      ).all(yStart, tStart, y2Start, yStart) as any[]).map((r) => ({
        shop: r.shop, totalPosted: r.totalPosted ?? 0, ready: r.ready ?? 0,
        postedYesterday: r.postedYesterday ?? 0, postedDayBefore: r.postedDayBefore ?? 0,
      }));
    } finally {
      vdb.close();
    }
  } catch (e: any) {
    d.videosErr = String(e?.message ?? e);
  }

  // 4. Đơn HÔM QUA per shop (4Seller, mọi tài khoản). 4Seller gom theo ngày US.
  try {
    const accounts = await listAccounts();
    if (!accounts.length) throw new Error("Chưa có tài khoản 4Seller");
    let anyOk = false;
    for (const acc of accounts) {
      const principal = `acct:${acc.uid}`;
      try {
        const list = await getShopList(principal);
        const ids = (list?.records ?? [])
          .filter((s) => !s.platform || /tiktok/i.test(String(s.platform)))
          .map((s) => s.id)
          .filter((x) => x != null);
        if (!ids.length) continue;
        const rows = await getSalesByShop(principal, { startTime: yesterday, endTime: yesterday, shopIds: ids });
        anyOk = true;
        for (const r of rows ?? []) {
          if (!r?.shopName) continue;
          const cur = d.orders.get(r.shopName) ?? { orders: 0, revenue: 0 };
          cur.orders += r.totalOrders ?? 0;
          cur.revenue += r.totalSales ?? 0;
          d.orders.set(r.shopName, cur);
        }
      } catch (e: any) {
        log(`⚠️ [${acc.label}] lấy đơn lỗi: ${e?.message}`);
      }
    }
    if (!anyOk) throw new Error("Mọi tài khoản 4Seller đều lỗi (cookie chết?)");
  } catch (e: any) {
    d.ordersErr = String(e?.message ?? e);
  }

  // 5+6. Low stock / Hết hàng + đơn overdue — tiktok.db (chỉ shop đã crawl TikTok Seller)
  if (fs.existsSync(TIKTOK_DB)) {
    let tdb: Database.Database | null = null;
    try {
      tdb = new Database(TIKTOK_DB, { readonly: true });
      try {
        d.stock = (tdb.prepare(
          `SELECT lv.shop, MAX(lv.run_date) runDate,
                  SUM(lv.stock > 0 AND lv.stock <= ?) low,
                  SUM(lv.stock = 0) outOf
           FROM listing_views lv
           JOIN (SELECT shop, MAX(run_date) md FROM listing_views GROUP BY shop) m
             ON m.shop = lv.shop AND m.md = lv.run_date
           WHERE lv.shop != ''
           GROUP BY lv.shop ORDER BY lv.shop`
        ).all(LOW_STOCK_AT) as any[]).map((r) => ({
          shop: r.shop, runDate: r.runDate, low: r.low ?? 0, outOf: r.outOf ?? 0, outNames: [] as string[],
        }));
        // Tên vài sp hết hàng (tối đa 3/shop) để biết cần nhập hàng gì
        const nameStmt = tdb.prepare(
          `SELECT product_name FROM listing_views WHERE shop=? AND run_date=? AND stock=0 AND product_name IS NOT NULL LIMIT 3`
        );
        for (const s of d.stock) {
          if (s.outOf > 0) s.outNames = (nameStmt.all(s.shop, s.runDate) as any[]).map((r) => String(r.product_name));
        }
      } catch (e: any) {
        d.stockErr = String(e?.message ?? e);
      }
      try {
        const shops = tdb.prepare(`SELECT DISTINCT shop FROM crawl_runs WHERE shop IS NOT NULL AND shop != ''`).all() as { shop: string }[];
        const stmt = tdb.prepare(
          `SELECT m.value_num v, r.run_date d FROM metrics m JOIN crawl_runs r ON r.id = m.run_id
           WHERE r.shop = ? AND m.key = 'action_shipping_overdue' ORDER BY m.run_id DESC LIMIT 1`
        );
        for (const s of shops) {
          const r = stmt.get(s.shop) as any;
          if (r && r.v != null) d.overdue.push({ shop: s.shop, runDate: r.d, overdue: Number(r.v) });
        }
      } catch (e: any) {
        d.overdueErr = String(e?.message ?? e);
      }
    } catch (e: any) {
      d.stockErr = d.stockErr ?? String(e?.message ?? e);
      d.overdueErr = d.overdueErr ?? String(e?.message ?? e);
    } finally {
      tdb?.close();
    }
  } else {
    d.stockErr = "Chưa có data/tiktok.db (chưa crawl TikTok Seller)";
    d.overdueErr = d.stockErr;
  }

  // 7. Snapshot ngày: đọc HÔM QUA (tính Δ) rồi upsert HÔM NAY
  try {
    const db = getDb();
    db.exec(
      `CREATE TABLE IF NOT EXISTS daily_report_snapshot (
         day TEXT NOT NULL, shop TEXT NOT NULL, active_listings INTEGER, total_videos INTEGER,
         PRIMARY KEY (day, shop))`
    );
    const yRows = db.prepare(`SELECT shop, active_listings FROM daily_report_snapshot WHERE day=?`).all(yesterday) as any[];
    for (const r of yRows) if (r.active_listings != null) d.snapYesterday.set(lc(r.shop), r.active_listings);

    const up = db.prepare(
      `INSERT INTO daily_report_snapshot (day, shop, active_listings, total_videos) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, shop) DO UPDATE SET active_listings=excluded.active_listings, total_videos=excluded.total_videos`
    );
    const videosByShop = new Map(d.videos.map((v) => [lc(v.shop), v.totalPosted]));
    for (const row of d.promo?.rows ?? []) {
      up.run(today, row.shop, row.activeListings, videosByShop.get(lc(row.shop)) ?? null);
    }
    // Shop chỉ có video (không nằm trong promo rows) vẫn snapshot phần video
    for (const v of d.videos) {
      if (!(d.promo?.rows ?? []).some((r) => lc(r.shop) === lc(v.shop))) up.run(today, v.shop, null, v.totalPosted);
    }
  } catch (e: any) {
    log(`⚠️ Snapshot lỗi: ${e?.message}`);
  }

  return d;
}

/* ============= Render (plain text, không markdown) ============= */

export function renderDailyReport(d: DailyReportData): string {
  const L: string[] = [];
  const warn = (e?: string) => `⚠️ Không lấy được data (${e ?? "?"})`;
  const promoRows = d.promo?.rows ?? [];

  L.push(`📊 DAILY REPORT · ${fmtDM(d.today)}`);
  if (d.promo) L.push(`(promo scan lúc ${fmtTs(d.promo.scannedAt)} · đơn tính theo ngày US)`);

  // ── 1. LISTING ──
  L.push("", "━━━ 📦 LISTING ━━━");
  if (d.promoErr) {
    L.push(warn(d.promoErr));
  } else {
    const total = promoRows.reduce((s, r) => s + (r.activeListings ?? 0), 0);
    const totalNew = [...d.newListedYesterday.values()].reduce((s, c) => s + c, 0);
    let totalDelta: number | null = null;
    if (d.snapYesterday.size) {
      totalDelta = promoRows.reduce((s, r) => {
        const prev = d.snapYesterday.get(lc(r.shop));
        return prev != null && r.activeListings != null ? s + (r.activeListings - prev) : s;
      }, 0);
    }
    L.push(`Tổng: ${total} listing${totalDelta != null ? ` (${sign(totalDelta)} so hôm qua)` : ""} · list mới hôm qua: ${totalNew}`);
    for (const r of [...promoRows].sort((a, b) => a.shop.localeCompare(b.shop))) {
      const prev = d.snapYesterday.get(lc(r.shop));
      const delta = prev != null && r.activeListings != null ? ` (${sign(r.activeListings - prev)})` : "";
      const newY = d.newListedYesterday.get(lc(r.shop)) ?? d.newListedYesterday.get(lc(shortShop(r.shop))) ?? 0;
      L.push(`• ${shortShop(r.shop)}: ${r.activeListings ?? "?"}${delta}${newY ? ` · +${newY} list hôm qua` : ""}`);
    }
    if (d.newListedErr) L.push(`⚠️ Số list hôm qua lỗi: ${d.newListedErr}`);
    if (!d.snapYesterday.size) L.push("(chưa có snapshot hôm qua — Δ sẽ có từ ngày mai)");
  }

  // ── 2. VIDEO ──
  L.push("", "━━━ 🎬 VIDEO ━━━");
  if (d.videosErr) {
    L.push(warn(d.videosErr));
  } else if (!d.videos.length) {
    L.push("Chưa có video nào trong Video Studio.");
  } else {
    const tY = d.videos.reduce((s, v) => s + v.postedYesterday, 0);
    const tY2 = d.videos.reduce((s, v) => s + v.postedDayBefore, 0);
    const tAll = d.videos.reduce((s, v) => s + v.totalPosted, 0);
    L.push(`Đăng hôm qua: ${tY} (hôm kia ${tY2}, ${sign(tY - tY2)}) · tổng đã đăng: ${tAll}`);
    for (const v of d.videos) {
      L.push(`• ${shortShop(v.shop)}: hôm qua ${v.postedYesterday} · tổng ${v.totalPosted}${v.ready ? ` · chờ đăng ${v.ready}` : ""}`);
    }
  }

  // ── 3. ĐƠN HÔM QUA ──
  L.push("", `━━━ 🛒 ĐƠN HÔM QUA (${fmtDM(d.yesterday)} · ngày US) ━━━`);
  if (d.ordersErr) {
    L.push(warn(d.ordersErr));
  } else {
    const rows = [...d.orders.entries()].filter(([, v]) => v.orders > 0).sort((a, b) => b[1].orders - a[1].orders);
    const tOrders = rows.reduce((s, [, v]) => s + v.orders, 0);
    const tRev = rows.reduce((s, [, v]) => s + v.revenue, 0);
    L.push(`Tổng: ${tOrders} đơn · ${money(tRev)}`);
    for (const [shop, v] of rows) L.push(`• ${shortShop(shop)}: ${v.orders} đơn · ${money(v.revenue)}`);
    const noOrder = promoRows.filter((r) => !(d.orders.get(r.shop)?.orders)).map((r) => shortShop(r.shop));
    if (noOrder.length) L.push(`0 đơn: ${noOrder.join(", ")}`);
  }

  // ── 4. HẾT FLASH ──
  L.push("", "━━━ ⚡ FLASH SALE ━━━");
  if (d.promoErr) {
    L.push(warn(d.promoErr));
  } else {
    const expired = promoRows.filter((r) => r.flashExpired);
    if (!expired.length) {
      L.push(`🎉 Cả ${promoRows.length} shop đều còn flash đang/sắp chạy.`);
    } else {
      L.push(`🔴 ${expired.length}/${promoRows.length} shop HẾT flash:`);
      for (const r of expired) {
        L.push(`• ${shortShop(r.shop)}${r.lastFlashEnd ? ` — hết từ ${fmtTs(r.lastFlashEnd)}` : " — chưa từng có flash"}`);
      }
    }
  }

  // ── 5. CHƯA DISCOUNT ──
  L.push("", `━━━ 🏷️ SP CHƯA DISCOUNT (>${UNCOVERED_ALERT_AT} sp) ━━━`);
  if (d.promoErr) {
    L.push(warn(d.promoErr));
  } else {
    const bad = promoRows
      .filter((r) => (r.uncoveredProducts ?? 0) > UNCOVERED_ALERT_AT)
      .sort((a, b) => (b.uncoveredProducts ?? 0) - (a.uncoveredProducts ?? 0));
    if (!bad.length) {
      L.push(`🎉 Không shop nào có quá ${UNCOVERED_ALERT_AT} sp chưa discount.`);
    } else {
      L.push(`🔴 ${bad.length} shop:`);
      for (const r of bad) L.push(`• ${shortShop(r.shop)}: ${r.uncoveredProducts} sp chưa discount (active ${r.activeListings ?? "?"})`);
    }
  }

  // ── 6. TỒN KHO ──
  L.push("", `━━━ 📉 TỒN KHO (Low ≤${LOW_STOCK_AT} · Hết = 0) ━━━`);
  if (d.stockErr) {
    L.push(warn(d.stockErr));
  } else {
    const bad = d.stock.filter((s) => s.low > 0 || s.outOf > 0);
    if (!bad.length) {
      L.push(`🎉 Không shop nào có sp low stock/hết hàng (${d.stock.length} shop đã crawl).`);
    } else {
      for (const s of bad.sort((a, b) => b.outOf - a.outOf || b.low - a.low)) {
        const parts: string[] = [];
        if (s.outOf) parts.push(`${s.outOf} HẾT HÀNG`);
        if (s.low) parts.push(`${s.low} low stock`);
        L.push(`• ${shortShop(s.shop)}: ${parts.join(" · ")} (crawl ${fmtDM(s.runDate)})`);
        for (const n of s.outNames) L.push(`   - ${n.slice(0, 60)}`);
      }
    }
    const crawled = new Set(d.stock.map((s) => lc(s.shop)));
    const notCrawled = promoRows.filter((r) => !crawled.has(lc(r.shop))).map((r) => shortShop(r.shop));
    if (notCrawled.length) L.push(`(chưa có data crawl: ${notCrawled.join(", ")})`);
  }

  // ── 7. ĐƠN OVERDUE ──
  L.push("", "━━━ ⏰ ĐƠN OVERDUE ━━━");
  if (d.overdueErr) {
    L.push(warn(d.overdueErr));
  } else {
    const bad = d.overdue.filter((o) => o.overdue > 0).sort((a, b) => b.overdue - a.overdue);
    if (!bad.length) {
      L.push(`🎉 Không có đơn quá hạn gửi (${d.overdue.length} shop đã crawl).`);
    } else {
      L.push(`🔴 ${bad.length} shop có đơn quá hạn:`);
      for (const o of bad) L.push(`• ${shortShop(o.shop)}: ${o.overdue} đơn overdue (crawl ${fmtDM(o.runDate)})`);
    }
  }

  return L.join("\n");
}

/* ============= Gửi Telegram ============= */

async function sendToReportChannel(text: string, log: (m: string) => void): Promise<boolean> {
  const cfg = reportTgConfig();
  if (!cfg) {
    log("DAILY_REPORT_TG_CHAT_ID chưa set — bỏ gửi.");
    return false;
  }
  try {
    for (const chunk of chunkText(text)) {
      await axios.post(
        `${TG_API}/bot${cfg.token}/sendMessage`,
        { chat_id: cfg.chatId, text: chunk, disable_web_page_preview: true },
        { timeout: 15000 }
      );
    }
    return true;
  } catch (e: any) {
    log("Gửi Telegram lỗi: " + (e?.response?.data?.description ?? e?.message ?? e));
    return false;
  }
}

/* ============= Job + cron ============= */

export async function runDailyReportOnce(opts?: { onLog?: (m: string) => void; noSend?: boolean }): Promise<{ text: string; sent: boolean }> {
  if (running) throw new Error("Daily report đang chạy — bỏ lượt này.");
  running = true;
  const log = opts?.onLog ?? ((m: string) => console.log("[daily-report]", m));
  try {
    log("▶ Gather data…");
    const data = await gatherData(log);
    const text = renderDailyReport(data);
    let sent = false;
    if (!opts?.noSend) {
      sent = await sendToReportChannel(text, log);
      log(sent ? "✅ Đã gửi daily report lên Telegram." : "✗ Không gửi được (xem log trên).");
    }
    return { text, sent };
  } finally {
    running = false;
  }
}

/** Đăng ký cron daily report. Gọi lúc bootstrap (index.ts). */
export function scheduleDailyReport(): void {
  if (!reportTgConfig()) {
    console.log("⏰ Daily report: TẮT (DAILY_REPORT_TG_CHAT_ID chưa set trong .env)");
    return;
  }
  const schedule = process.env.DAILY_REPORT_CRON || "0 8 * * *";
  if (!cron.validate(schedule)) {
    console.error(`⏰ Daily report: lịch không hợp lệ "${schedule}" — bỏ qua.`);
    return;
  }
  task?.stop();
  task = cron.schedule(schedule, () => {
    runDailyReportOnce().catch((e) => console.warn("[daily-report] ✗", e?.message ?? e));
  }, { timezone: "Asia/Ho_Chi_Minh" });
  console.log(`⏰ Daily report cron: ${schedule} (Asia/Ho_Chi_Minh) → chat ${process.env.DAILY_REPORT_TG_CHAT_ID}`);
}
