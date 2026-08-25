/**
 * Runner độc lập để test 1 file JSON listing.
 *
 * Usage:
 *   npx tsx src/scripts/runOne.ts <path> --user=<username> [--dry-run] [--no-notify]
 *
 * --user=X    : (bắt buộc) username chủ cookie 4Seller (data/cookies/X.json)
 * --dry-run   : bỏ qua bước Save & Publish (chỉ tạo draft)
 * --no-notify : không gửi Telegram notification
 */
import "dotenv/config";
import path from "path";
import { listing4sellerShein } from "../core/listing4sellerShein";
import { getProfileNameFromFolder } from "../core/steps/randomUtils";
import { notifyFail } from "../services/notification/telegram";

const main = async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const noNotify = args.includes("--no-notify");
  const headed = args.includes("--headed"); // hiện browser để xem (override worker.json headless)
  const userArg = args.find((a) => a.startsWith("--user="));
  const cookieUser = userArg?.slice("--user=".length);

  if (!file) {
    console.error(
      "Usage: npx tsx src/scripts/runOne.ts <path> --user=<username> [--dry-run] [--no-notify]"
    );
    process.exit(1);
  }
  if (!cookieUser) {
    console.error("Phải truyền --user=<username> để worker biết dùng cookie nào.");
    process.exit(1);
  }

  // Relative path → resolve từ CWD (chứ không hardcode Downloads dir)
  const absFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const profile = getProfileNameFromFolder(absFile);
  const fileName = path.basename(absFile);
  const folder = path.basename(path.dirname(absFile));

  console.log(`▶️ Test runner: ${absFile} ${dryRun ? "(DRY-RUN, no publish)" : "(LIVE PUBLISH)"}`);
  console.log(`   Profile: ${profile}  Notify: ${noNotify ? "off" : "on"}`);
  const t0 = Date.now();

  try {
    await listing4sellerShein(absFile, { dryRun, cookieUser, ...(headed ? { headless: false } : {}) });
    const durationMs = Date.now() - t0;
    console.log(`✅ Done in ${Math.round(durationMs / 1000)}s`);
    // Không bắn Telegram khi success — chỉ notify fail
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
