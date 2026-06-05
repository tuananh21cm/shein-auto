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
  onLog?: (m: string) => void;
}

/** Chạy 1 lượt crawl + phân tích. Dùng cho cả cron lẫn gọi thủ công. */
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
    if (!cfg.profileId) throw new Error("Chưa cấu hình profileId trong config/tiktok.json");

    const discoverDir = opts.discover
      ? path.resolve(process.cwd(), "data", "_tiktok_discovery", new Date().toISOString().slice(0, 10))
      : undefined;

    log("▶ Bắt đầu crawl TikTok seller…");
    const snap = await crawlTiktokSeller({ profileId: cfg.profileId, db, discoverDir, onLog: log });
    log(`Crawl xong: status=${snap.status}, ${snap.routes.length} route.`);

    if (opts.discover) {
      log(`Discovery dump tại: ${discoverDir}`);
      return;
    }
    if (opts.noAi || !cfg.analyze) {
      log("Bỏ bước phân tích AI (--no-ai / analyze=false).");
      return;
    }

    const yMetrics = db.getMetricsByDate(yesterdayStr(snap.runDate));
    log("Gọi Claude phân tích…");
    const analysis = await analyzeSnapshot(snap, yMetrics, { model: cfg.model });
    const md = renderMarkdown(snap, analysis, yMetrics);

    const reportDir = path.resolve(process.cwd(), "docs", "reports");
    await fs.ensureDir(reportDir);
    const reportPath = path.join(reportDir, `${snap.runDate}-tiktok.md`);
    await fs.writeFile(reportPath, md, "utf-8");
    db.insertReport(snap.runId, path.relative(process.cwd(), reportPath), cfg.model);
    if (analysis.alerts.length) db.insertAlerts(snap.runId, analysis.alerts);

    log(`✅ Báo cáo: ${reportPath} (${analysis.alerts.length} alert).`);
  } catch (e: any) {
    console.error("[tiktok-cron] ✗ Lỗi:", e?.message ?? e);
  } finally {
    db.close();
    running = false;
  }
}

/** Đăng ký cron theo tiktok.json. Gọi lúc bootstrap. */
export function scheduleTiktokCron(): void {
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
