/**
 * researchCron — tự chạy vòng research hằng sáng (config/research.json → cron).
 *
 * Mặc định: chỉ chạy `runDailyResearch` (an toàn — chỉ RapidAPI, không browser).
 * Nếu cron.autoEnrich=true + có enrichProfileId → enrich sold thật qua Kiki sau đó
 * (rủi ro captcha → để TẮT mặc định, hợp mô hình bán tự động).
 *
 * Chống chạy chồng: nếu vòng trước chưa xong thì bỏ lượt.
 */
import cron, { type ScheduledTask } from "node-cron";
import { researchConfig } from "../../config/appConfig";
import { runDailyResearch } from "./dailyResearch";
import { enrichCandidates } from "./enrichCandidates";

let running = false;
let task: ScheduledTask | null = null;

/** Chạy 1 lượt research (+ auto-enrich nếu bật). Dùng được cả cho gọi thủ công. */
export async function runResearchJob(): Promise<void> {
  if (running) {
    console.log("[research-cron] Vòng trước chưa xong — bỏ lượt này.");
    return;
  }
  running = true;
  try {
    const cfg = researchConfig();
    console.log("[research-cron] ▶ Bắt đầu vòng research tự động…");
    const r = await runDailyResearch({ onLog: (m) => console.log("[research-cron]", m) });

    if (cfg.cron?.autoEnrich && cfg.cron.enrichProfileId) {
      const limit = cfg.cron.enrichLimit ?? 20;
      console.log(`[research-cron] Auto-enrich top ${limit} bằng Kiki…`);
      await enrichCandidates({
        profileId: cfg.cron.enrichProfileId,
        day: r.day,
        limit,
        onLog: (m) => console.log("[research-cron]", m),
      });
    }
    console.log(`[research-cron] ✅ Xong: ${r.candidates} candidate / ${r.nichesScanned} ngách.`);
  } catch (e: any) {
    console.error("[research-cron] ✗ Lỗi:", e?.message ?? e);
  } finally {
    running = false;
  }
}

/** Đăng ký cron theo research.json. Gọi lúc bootstrap. */
export function scheduleResearchCron(): void {
  const c = researchConfig().cron;
  if (!c?.enabled) {
    console.log("⏰ Research cron: TẮT (research.json → cron.enabled=false)");
    return;
  }
  if (!cron.validate(c.schedule)) {
    console.error(`⏰ Research cron: lịch không hợp lệ "${c.schedule}" — bỏ qua.`);
    return;
  }
  task?.stop();
  task = cron.schedule(c.schedule, runResearchJob, c.timezone ? { timezone: c.timezone } : undefined);
  console.log(
    `⏰ Research cron: ${c.schedule}${c.timezone ? ` (${c.timezone})` : ""}` +
      (c.autoEnrich && c.enrichProfileId ? " + auto-enrich Kiki" : "")
  );
}
