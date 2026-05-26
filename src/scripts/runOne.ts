/**
 * Runner độc lập để test 1 file JSON listing.
 *
 * Usage:
 *   npx tsx src/scripts/runOne.ts SheinAuto/P5-014/test.json [--dry-run] [--no-notify]
 *
 * --dry-run   : bỏ qua bước Save & Publish (chỉ tạo draft)
 * --no-notify : không gửi Telegram notification
 */
import "dotenv/config";
import path from "path";
import { listing4sellerShein } from "../core/listing4sellerShein";
import { getProfileNameFromFolder } from "../core/steps/randomUtils";
import { notifySuccess, notifyFail } from "../services/notification/telegram";

const main = async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const noNotify = args.includes("--no-notify");

  if (!file) {
    console.error(
      "Usage: npx tsx src/scripts/runOne.ts <relative-path-from-Downloads> [--dry-run] [--no-notify]"
    );
    process.exit(1);
  }

  const absFile = path.isAbsolute(file) ? file : path.join("C:/Users/KBT/Downloads", file);
  const profile = getProfileNameFromFolder(absFile);
  const fileName = path.basename(absFile);
  const folder = path.basename(path.dirname(absFile));

  console.log(`▶️ Test runner: ${absFile} ${dryRun ? "(DRY-RUN, no publish)" : "(LIVE PUBLISH)"}`);
  console.log(`   Profile: ${profile}  Notify: ${noNotify ? "off" : "on"}`);
  const t0 = Date.now();

  try {
    await listing4sellerShein(absFile, { dryRun });
    const durationMs = Date.now() - t0;
    console.log(`✅ Done in ${Math.round(durationMs / 1000)}s`);
    if (!noNotify && !dryRun) {
      await notifySuccess({ file: fileName, folder, profile, durationMs });
      console.log("📤 Đã gửi Telegram notify (success)");
    }
    process.exit(0);
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const errorMessage = err?.message ?? String(err);
    console.error(`❌ Failed in ${Math.round(durationMs / 1000)}s:`, errorMessage);
    if (!noNotify && !dryRun) {
      await notifyFail({ file: fileName, folder, profile, errorMessage }).catch(() => {});
      console.log("📤 Đã gửi Telegram notify (fail)");
    }
    process.exit(2);
  }
};

main();
