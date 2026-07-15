/**
 * Chạy tay daily report (test / gửi lại).
 *
 * Usage:
 *   npx tsx src/scripts/runDailyReport.ts            # gather + gửi vào kênh DAILY_REPORT_TG_CHAT_ID
 *   npx tsx src/scripts/runDailyReport.ts --dry      # chỉ in report ra console, KHÔNG gửi
 */
import "dotenv/config";
import { runDailyReportOnce } from "../core/dailyReport";

const main = async () => {
  const dry = process.argv.includes("--dry");
  const { text, sent } = await runDailyReportOnce({ noSend: dry, onLog: (m) => console.log("[daily-report]", m) });
  console.log("\n──────── REPORT ────────\n" + text + "\n────────────────────────");
  console.log(JSON.stringify({ ok: true, sent, dry, chars: text.length }));
};

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
