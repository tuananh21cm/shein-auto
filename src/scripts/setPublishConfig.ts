/**
 * Đổi config auto-publish (lưu data/video-publish.json).
 * Usage: npx tsx src/scripts/setPublishConfig.ts --perDay=10 --gap=60 --jitter=20 --from=20 --to=9 --auto=1
 * Chỉ đổi field được truyền; bỏ trống thì giữ nguyên.
 */
import { loadPublishState, savePublishState } from "../core/videoStudio/publishScheduler";

const num = (k: string) => {
  const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return v === undefined ? undefined : Number(v);
};

const before = loadPublishState();
const cfg: any = { ...before.cfg };
if (num("perDay") !== undefined) cfg.perShopPerDay = num("perDay");
if (num("gap") !== undefined) cfg.minGapMin = num("gap");
if (num("jitter") !== undefined) cfg.jitterMin = num("jitter");
if (num("from") !== undefined) cfg.hourFrom = num("from");
if (num("to") !== undefined) cfg.hourTo = num("to");
const auto = num("auto");

const after = savePublishState({ cfg, ...(auto !== undefined ? { auto: !!auto } : {}) });
console.log("TRƯỚC:", JSON.stringify(before));
console.log("SAU  :", JSON.stringify(after));

// Cảnh báo nếu quota không nhét vừa khung giờ
const windowHrs = after.cfg.hourFrom < after.cfg.hourTo
  ? after.cfg.hourTo - after.cfg.hourFrom
  : 24 - after.cfg.hourFrom + after.cfg.hourTo;
const needMin = (after.cfg.perShopPerDay - 1) * after.cfg.minGapMin;
console.log(`\nKhung đăng: ${windowHrs}h = ${windowHrs * 60}′. Cần tối thiểu ${needMin}′ để rải ${after.cfg.perShopPerDay} video (gap ${after.cfg.minGapMin}′).`);
console.log(needMin <= windowHrs * 60
  ? `✅ Vừa khung — 1 shop có thể đạt ${after.cfg.perShopPerDay} video/ngày.`
  : `⚠️ KHÔNG vừa: cần ${needMin}′ > ${windowHrs * 60}′. Giảm gap hoặc nới khung giờ.`);
