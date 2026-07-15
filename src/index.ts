import cron from "node-cron";
import { config } from "./config";
import { runFileRouterOnce } from "./queue/fileRouter";
import { runPodRouterOnce } from "./queue/podRouter";
import { runQueueManagerOnce } from "./queue/queueManager";
import { startAdminServer } from "./adminServer";
import { installConsoleTap } from "./state/eventBus";
import { historyStore } from "./state/historyStore";
import { refreshQueueSnapshot } from "./state/queueState";
import { geminiCache } from "./services/gemini/geminiCache";
import { initDb, closeDb } from "./state/db";
import { scheduleResearchCron } from "./core/research/researchCron";
import { scheduleTiktokCron } from "./core/tiktokCron";
import { scheduleDripPublisher } from "./core/dripPublisher";
import { scheduleAutoCrawler } from "./core/autoCrawler";
import { scheduleHarvester } from "./core/linkHarvester";
import { schedulePromotionCron } from "./core/promotionScan";
import { scheduleFlashAuto } from "./core/flashDeal";
import { schedulePublishCron } from "./core/videoStudio/publishScheduler";
import { scheduleVideoQueueCron } from "./core/videoStudio/videoQueue";
import { scheduleDailyReport } from "./core/dailyReport";

// Pipe console.* lên eventBus để SSE stream xuống UI. Phải gọi sớm.
installConsoleTap();

console.log("==============================================");
console.log("  SHEIN AUTO WORKER");
console.log("==============================================");
console.log(`📂 Download dir : ${config.downloadDir}`);
console.log(`📂 Base dir     : ${config.baseSheinAutoDir}`);
console.log(`⏰ File router  : ${config.cronFileRouter}`);
console.log(`⏰ Queue manager: ${config.cronQueueManager}`);
console.log("==============================================\n");

const bootstrap = async () => {
  await initDb(); // SQLite — phải init đầu tiên (auto-import legacy JSON)
  await Promise.all([historyStore.init(), geminiCache.init()]);
  refreshQueueSnapshot().catch(() => {});
  // Bind port TRƯỚC — nếu trùng instance sẽ throw EADDRINUSE và thoát ở catch.
  await startAdminServer();

  // Cron CHỈ đăng ký SAU khi bind port thành công → đảm bảo 1 instance duy nhất
  // chạy cron. Tránh nhiều server zombie cùng pick 1 file → đăng trùng nhiều lần.
  cron.schedule(config.cronFileRouter, runFileRouterOnce);
  cron.schedule(config.cronFileRouter, () => runPodRouterOnce()); // POD inbox → JSON vào queue
  cron.schedule(config.cronQueueManager, runQueueManagerOnce);
  scheduleResearchCron();
  scheduleTiktokCron();
  scheduleDripPublisher();
  scheduleAutoCrawler();
  scheduleHarvester();
  schedulePromotionCron();
  scheduleFlashAuto();
  schedulePublishCron();
  scheduleVideoQueueCron();
  scheduleDailyReport();
  console.log("⏰ Đã đăng ký cron (instance này giữ port → chạy cron).");
};
bootstrap().catch((err: any) => {
  if (err?.code === "EADDRINUSE") {
    const port = process.env.ADMIN_PORT ?? 3000;
    console.error(`⛔ Cổng ${port} đã có instance shein-auto khác chạy. THOÁT để tránh chạy trùng cron (sẽ đăng listing nhiều lần). Hãy tắt instance cũ trước.`);
  } else {
    console.error("❌ Bootstrap failed:", err?.message ?? err);
  }
  process.exit(1);
});

const shutdown = (signal: string) => {
  console.log(`\n📴 Nhận ${signal}, dừng worker...`);
  closeDb();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection (server vẫn chạy):", reason);
});

// QUAN TRỌNG: KHÔNG để 1 lỗi lẻ kill cả server. puppeteer/node-html-to-image (render
// banner/size-guide) khi Chromium con crash/timeout có thể phát 'error' event không có
// listener → Node biến thành uncaughtException → mặc định THOÁT process. Mỗi listing đã
// được bọc try/catch riêng nên nuốt + log ở đây để worker sống tiếp, không "tắt luôn server".
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception (server vẫn chạy):", err?.stack || err);
});

