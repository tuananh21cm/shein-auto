/**
 * Bật/tắt từng cron theo MÁY (config/crons.json).
 *
 * Lý do tồn tại: repo này chạy trên nhiều máy, mỗi máy gánh một mảng việc
 * (máy A: cào + đăng listing · máy B: render + đăng video). Trước đây muốn tắt
 * phải sửa rải rác worker.json/crawl.json/harvest.json…, còn promotionScan +
 * videoQueue thì hardcode không tắt được. File này gom về MỘT chỗ.
 *
 * Thiếu file / thiếu key → mặc định BẬT, để máy cũ không đổi hành vi sau khi update.
 */
import fs from "fs-extra";
import path from "path";

export type CronName =
  | "fileRouter" | "podRouter" | "queueManager" | "research" | "tiktokAnalytics"
  | "dripPublish" | "autoCrawl" | "linkHarvester" | "promotionScan" | "flashAuto"
  | "videoQueue" | "videoPublish" | "dailyReport";

const FILE = path.resolve(process.cwd(), "config", "crons.json");

let cache: Record<string, unknown> | null = null;

function load(): Record<string, unknown> {
  if (cache) return cache;
  try {
    cache = fs.readJsonSync(FILE);
  } catch {
    cache = {}; // không có file → bật hết (hành vi cũ)
  }
  return cache!;
}

/** Cron này có được đăng ký trên máy hiện tại không? Mặc định true. */
export function cronEnabled(name: CronName): boolean {
  return load()[name] !== false;
}

/** Log 1 dòng tổng kết những cron bị tắt — để nhìn log boot là biết máy này gánh gì. */
export function logDisabledCrons(names: CronName[]): void {
  const off = names.filter((n) => !cronEnabled(n));
  if (off.length) {
    console.log(`⏰ TẮT theo config/crons.json (${off.length}): ${off.join(", ")}`);
  }
}
