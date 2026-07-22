/**
 * tiktokCron — cào TikTok seller + phân tích Claude 1 lần/ngày (config/tiktok.json).
 * Pattern theo researchCron: chống chạy chồng, validate lịch, gọi được thủ công.
 */
import cron, { type ScheduledTask } from "node-cron";
import fs from "fs-extra";
import path from "path";
import { tiktokConfig } from "../config/appConfig";
import { crawlTiktokSeller } from "./crawlTiktokSeller";
import { TiktokDb } from "../services/tiktok/db";
import { analyzeSnapshot } from "../services/tiktok/analyze";
import { renderMarkdown } from "../services/tiktok/renderReport";
import { sendTiktokReport, renderTelegram } from "../services/tiktok/notifyReport";

let running = false;
let task: ScheduledTask | null = null;

function yesterdayStr(runDate: string): string {
  const d = new Date(runDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface RunTiktokOptions {
  discover?: boolean;
  noAi?: boolean;
  /** Chỉ chạy 1 shop cụ thể (theo tên shop trong shop_tiktok_profile). */
  onlyShop?: string;
  onLog?: (m: string) => void;
}

const CRAWL_TIMEOUT_MS = 12 * 60_000; // treo quá 12p → hủy, sang shop khác (chống kẹt #38)

/** Race promise với timeout — chống crawl treo vô hạn. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${Math.round(ms / 60000)}p (crawl treo)`)), ms)),
  ]);
}

/** Bóc vài chỉ số headline từ snapshot cho UI (revenue/orders/conversion/visitors/unread). */
function extractKeyMetrics(snap: any): Record<string, number | null> {
  const flat: Record<string, number> = {};
  for (const r of snap.routes ?? []) {
    for (const m of r.metrics ?? []) {
      if (m.valueNum != null && flat[m.key] == null) flat[m.key] = m.valueNum;
    }
  }
  const pick = (...keys: string[]) => { for (const k of keys) if (flat[k] != null) return flat[k]; return null; };
  return {
    revenue: pick("revenue", "gross_revenue", "gmv", "video_revenue"),
    orders: pick("orders", "main_order_cnt", "total_orders"),
    conversion: pick("conversion_rate", "conversion", "cvr"),
    visitors: pick("visitors", "visitor_cnt", "uv"),
    views: pick("views", "page_views", "pv"),
    unread: pick("unread_total"),
  };
}

const sevRank = (o: string) => (o === "critical" ? 0 : o === "warning" ? 1 : o === "good" ? 2 : 3);
const sevEmoji = (o: string) => (o === "critical" ? "🔴" : o === "warning" ? "🟡" : o === "good" ? "🟢" : "⚪");
const shortShopName = (s: string) =>
  String(s).replace(/^T[AN] /, "").replace(/_US$/, "").replace(/Scan ?\d+\s*[-—]?\s*/, "").trim() || s;

/** Gửi 1 digest tổng hợp mọi shop (triage theo sức khỏe) — thay 14 tin per-shop. */
async function sendDailyDigest(db: TiktokDb, log: (m: string) => void): Promise<void> {
  const parse = (s: any, d: any) => { try { return JSON.parse(s); } catch { return d; } };
  const items = db.listShopAnalysis().map((r: any) => ({
    shop: r.shop, overall: r.overall, status: r.status, runDate: r.run_date,
    alerts: parse(r.alerts_json, []), metrics: parse(r.metrics_json, {}),
  })).sort((a, b) => sevRank(a.overall) - sevRank(b.overall));
  if (!items.length) return;

  const c = items.filter((i) => i.overall === "critical");
  const w = items.filter((i) => i.overall === "warning");
  const g = items.filter((i) => i.overall === "good");
  const totAlerts = items.reduce((s, i) => s + (i.alerts?.length ?? 0), 0);
  const date = (items[0]?.runDate || "").slice(5).replace("-", "/");

  const lines: string[] = [];
  lines.push(`🩺 Shop Health · ${date} · ${items.length} shop`);
  lines.push(`🔴 ${c.length} · 🟡 ${w.length} · 🟢 ${g.length}  ·  ${totAlerts} cảnh báo`);
  const action = [...c, ...w];
  if (action.length) {
    lines.push("", "⚠️ XỬ LÝ NGAY");
    for (const i of action.slice(0, 12)) {
      const top = i.alerts?.[0]?.title || "ổn";
      lines.push(`• ${shortShopName(i.shop)} ${sevEmoji(i.overall)} ${top}`.slice(0, 95));
    }
    if (action.length > 12) lines.push(`… +${action.length - 12} shop nữa`);
  }
  if (g.length) lines.push("", `🟢 Tốt (${g.length}): ${g.map((i) => shortShopName(i.shop)).join(", ")}`.slice(0, 240));
  const byRev = items.filter((i) => i.metrics?.revenue != null).sort((a, b) => b.metrics.revenue - a.metrics.revenue).slice(0, 3);
  if (byRev.length && byRev[0].metrics.revenue > 0) {
    lines.push("", `📈 Rev: ${byRev.map((i) => `${shortShopName(i.shop)} $${i.metrics.revenue}`).join(" · ")}`);
  }
  await sendTiktokReport(lines.join("\n"), log).catch(() => {});
  log("📣 Đã gửi digest tổng hợp lên Telegram.");
}

/** Phân tích 1 shop: crawl (có timeout) → AI → lưu report + shop_analysis + Telegram.
 *  digest=true (chạy full) → KHÔNG gửi Telegram per-shop (để gộp vào digest cuối). */
async function analyzeOneShop(
  shop: string | null, profile: string, cfg: any, db: TiktokDb, opts: RunTiktokOptions,
  log: (m: string) => void, digest = false
): Promise<void> {
  const tag = shop ?? "(config)";
  const snap = await withTimeout(
    crawlTiktokSeller({ profileId: profile, shop, db, onLog: (m) => log(`[${tag}] ${m}`) }),
    CRAWL_TIMEOUT_MS, `[${tag}] crawl`
  );
  log(`[${tag}] crawl: status=${snap.status}, ${snap.routes.length} route`);

  if (opts.noAi || !cfg.analyze) { log(`[${tag}] bỏ AI.`); return; }

  // login_required → cảnh báo, KHÔNG tốn token AI phân tích trang login.
  if (snap.status === "login_required") {
    log(`[${tag}] ⚠️ login_required — cảnh báo, bỏ AI.`);
    if (!digest) await sendTiktokReport(`⚠️ Shop ${tag}: profile Kiki cần ĐĂNG NHẬP LẠI TikTok Seller (crawl=login_required, ${snap.runDate}).`, log).catch(() => {});
    db.upsertShopAnalysis({
      shop: tag, runDate: snap.runDate, runId: snap.runId, status: snap.status, overall: "critical",
      summary: "Profile Kiki cần đăng nhập lại TikTok.", areasJson: "[]",
      alertsJson: JSON.stringify([{ severity: "high", title: "Cần đăng nhập lại", detail: "crawl=login_required", action: "Mở Kiki profile, đăng nhập lại TikTok Seller Center" }]),
      metricsJson: "{}", reportPath: "",
    });
    return;
  }

  const yMetrics = db.getMetricsByShopDate(shop, yesterdayStr(snap.runDate));
  log(`[${tag}] gọi Claude phân tích…`);
  const analysis = await analyzeSnapshot(snap, yMetrics, { model: cfg.model });
  const md = renderMarkdown(snap, analysis, yMetrics);

  const slug = (shop ?? "config").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 40);
  const reportDir = path.resolve(process.cwd(), "docs", "reports");
  await fs.ensureDir(reportDir);
  const reportPath = path.join(reportDir, `${snap.runDate}-${slug}-tiktok.md`);
  await fs.writeFile(reportPath, md, "utf-8");
  const relPath = path.relative(process.cwd(), reportPath);
  db.insertReport(snap.runId, relPath, cfg.model);
  if (analysis.alerts.length) db.insertAlerts(snap.runId, analysis.alerts);

  db.upsertShopAnalysis({
    shop: tag, runDate: snap.runDate, runId: snap.runId, status: snap.status,
    overall: analysis.overallStatus, summary: analysis.summary,
    areasJson: JSON.stringify(analysis.areas ?? []), alertsJson: JSON.stringify(analysis.alerts ?? []),
    metricsJson: JSON.stringify(extractKeyMetrics(snap)), reportPath: relPath,
  });
  log(`[${tag}] ✅ ${analysis.overallStatus} · ${analysis.alerts.length} alert · ${relPath}`);
  if (!digest) await sendTiktokReport(renderTelegram(snap, analysis, relPath), log).catch(() => {});
}

/** Chạy 1 lượt crawl + phân tích cho MỌI shop đã gán Kiki-TikTok profile (tuần tự). */
export async function runTiktokJob(opts: RunTiktokOptions = {}): Promise<void> {
  if (running) {
    console.log("[tiktok-cron] Vòng trước chưa xong — bỏ lượt này.");
    return;
  }
  running = true;
  const log = opts.onLog ?? ((m: string) => console.log("[tiktok]", m));
  const db = new TiktokDb();
  try {
    const cfg = tiktokConfig();

    // Discovery: vẫn chạy 1 profile config (debug selector).
    if (opts.discover) {
      if (!cfg.profileId) throw new Error("Discovery cần profileId trong config/tiktok.json");
      const discoverDir = path.resolve(process.cwd(), "data", "_tiktok_discovery", new Date().toISOString().slice(0, 10));
      log("▶ Discovery crawl…");
      const snap = await crawlTiktokSeller({ profileId: cfg.profileId, db, discoverDir, onLog: log });
      log(`Discovery xong: status=${snap.status}, dump tại ${discoverDir}`);
      return;
    }

    // Driver = shop_tiktok_profile. Rỗng → fallback profile config (giữ behavior cũ).
    let runList = db.listShopProfiles().map((s) => ({ shop: s.shop as string | null, profile: s.kiki_profile }));
    if (opts.onlyShop) runList = runList.filter((r) => r.shop === opts.onlyShop);
    if (runList.length === 0 && !opts.onlyShop) {
      if (!cfg.profileId) throw new Error("Chưa shop nào gán Kiki-TikTok profile và config trống.");
      runList = [{ shop: null, profile: cfg.profileId }];
      log("Chưa gán shop nào → chạy profile config (1 shop).");
    }
    if (runList.length === 0) { log("Không có shop khớp để chạy."); return; }

    // Full run (không onlyShop, nhiều shop) → digest gộp; bỏ tin per-shop.
    const digest = !opts.onlyShop && runList.length > 1;
    log(`▶ Phân tích ${runList.length} shop${digest ? " (digest gộp cuối)" : ""}: ${runList.map((r) => r.shop ?? "(config)").join(", ")}`);
    let ok = 0, fail = 0;
    for (const { shop, profile } of runList) {
      try {
        await analyzeOneShop(shop, profile, cfg, db, opts, log, digest);
        ok++;
      } catch (e: any) {
        fail++;
        console.error(`[tiktok-cron] ✗ [${shop ?? "(config)"}] lỗi:`, e?.message ?? e);
        log(`✗ [${shop ?? "(config)"}] lỗi: ${String(e?.message ?? e).slice(0, 100)}`);
      }
    }
    if (digest) await sendDailyDigest(db, log);
    log(`🏁 Xong: ✅ ${ok} shop · ❌ ${fail} shop.`);
  } catch (e: any) {
    console.error("[tiktok-cron] ✗ Lỗi:", e?.message ?? e);
  } finally {
    db.close();
    running = false;
  }
}

/** Đăng ký cron theo tiktok.json. Gọi lúc bootstrap. */
export function scheduleTiktokCron(): void {
  // Máy không có Kiki (đã chuyển sang máy khác) → tắt bằng .env, không đụng tiktok.json
  // (file đó vào git, sửa sẽ lây sang máy kia khi pull).
  if (process.env.DISABLE_TIKTOK_CRON === "1") {
    console.log("⏰ TikTok cron: TẮT (.env → DISABLE_TIKTOK_CRON=1)");
    return;
  }
  const c = tiktokConfig();
  if (!c.enabled) {
    console.log("⏰ TikTok cron: TẮT (tiktok.json → enabled=false)");
    return;
  }
  if (!cron.validate(c.cron)) {
    console.error(`⏰ TikTok cron: lịch không hợp lệ "${c.cron}" — bỏ qua.`);
    return;
  }
  task?.stop();
  task = cron.schedule(c.cron, () => runTiktokJob(), c.timezone ? { timezone: c.timezone } : undefined);
  console.log(`⏰ TikTok cron: ${c.cron}${c.timezone ? ` (${c.timezone})` : ""}`);
}
