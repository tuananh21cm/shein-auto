/**
 * Pre-check cho addon TikCheck (yêu cầu 14/09/2026): addon gọi TRƯỚC khi hiện panel, server trả
 * `mask` = có che hiển thị (tiền về $0 + trạng thái "Account deactivated") hay không. CHỈ ảnh hưởng
 * hiển thị trên panel nội bộ; dữ liệu addon đẩy về CRM/tooltik vẫn là số thật.
 *
 *  - Danh sách shop hệ thống: data/tikcrm/system_shops.json (mã shop, nạp từ CSV của CRM).
 *  - Luật 1 (anh chốt 14/09/2026, lần 3): CHỈ khi NET EARNINGS > 0 và shop KHÔNG thuộc hệ thống → mask.
 *    On hold / reserve / paid không tính; acc die mà net = 0 đương nhiên không che. (`money` addon gửi chỉ để log.)
 *  - Luật 2 (random ≤10 shop Live cũ/ngày): ĐANG TẮT (RULE2_ENABLED=false, anh chốt 14/09/2026). Bật lại = đổi cờ.
 *    Quyết định lưu theo ngày (data/tikcrm/mask_daily.json) để cùng shop mở lại trong ngày vẫn nhất quán.
 *  - Mọi lượt gọi ghi data/tikcrm/pre_log.jsonl (soi ai đang mở shop ngoài hệ thống).
 */
import fs from "fs-extra";
import path from "path";
import { dayKey } from "./dailyStore";

const DIR = path.resolve(process.cwd(), "data", "tikcrm");
const SYSTEM_FILE = path.join(DIR, "system_shops.json");
const DAILY_FILE = path.join(DIR, "mask_daily.json");
const LOG_FILE = path.join(DIR, "pre_log.jsonl");
const RULE2_ENABLED = false; // luật 2 tắt theo yêu cầu 14/09/2026
const DAILY_QUOTA = 10;      // luật 2: tối đa 10 shop/ngày
const PICK_PROB = 0.5;       // xác suất chọn mỗi shop đủ điều kiện, tới khi đủ quota
const OLD_ACCOUNT_DAYS = 1000;

const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();

export function getSystemShops(): string[] {
  try { return (fs.readJsonSync(SYSTEM_FILE) as string[]).map(norm).filter(Boolean); } catch { return []; }
}
export function setSystemShops(codes: string[]): number {
  fs.ensureDirSync(DIR);
  const uniq = [...new Set(codes.map(norm).filter(Boolean))];
  fs.writeJsonSync(SYSTEM_FILE, uniq);
  return uniq.length;
}

interface Daily { day: string; picked: string[]; decided: Record<string, boolean> }
function readDaily(): Daily {
  const today = dayKey();
  try { const d = fs.readJsonSync(DAILY_FILE) as Daily; if (d.day === today) return d; } catch { /* mới */ }
  return { day: today, picked: [], decided: {} };
}
export function getMaskDaily(): Daily { return readDaily(); }

export interface PreInput { code: string; name?: string; money: number; net: number; ageDays: number | null; live: boolean }
export interface PreResult { known: boolean; mask: boolean; reason: string; day: string }

export function preCheck(input: PreInput): PreResult {
  const code = norm(input.code);
  const known = getSystemShops().includes(code);
  const daily = readDaily();
  let mask = false, reason = "normal";

  if (input.net <= 0) {                                    // không có net earnings → không bao giờ che
    reason = "no-net";
  } else if (!known) {                                     // luật 1: ngoài hệ thống + có net
    mask = true; reason = "outside-system-with-net";
  } else if (RULE2_ENABLED && input.live && (input.ageDays ?? 0) > OLD_ACCOUNT_DAYS) {   // luật 2
    if (code in daily.decided) { mask = daily.decided[code]; reason = mask ? "daily-random" : "daily-random-skip"; }
    else if (daily.picked.length < DAILY_QUOTA) {
      mask = Math.random() < PICK_PROB;
      daily.decided[code] = mask;
      if (mask) daily.picked.push(code);
      reason = mask ? "daily-random" : "daily-random-skip";
      fs.ensureDirSync(DIR); fs.writeJsonSync(DAILY_FILE, daily);
    } else reason = "daily-quota-full";
  }

  try {
    fs.ensureDirSync(DIR);
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), code, name: input.name ?? "", known, money: input.money, age_days: input.ageDays, live: input.live, mask, reason }) + "\n");
  } catch { /* log không chặn */ }
  return { known, mask, reason, day: daily.day };
}
