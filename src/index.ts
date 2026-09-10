import cron from "node-cron";
import { config } from "./config";
import { runFileRouterOnce } from "./queue/fileRouter";
import { runQueueManagerOnce, recoverOrphanedProcessing } from "./queue/queueManager";
import { startAdminServer } from "./adminServer";
import { installConsoleTap } from "./state/eventBus";
import { historyStore } from "./state/historyStore";
import { refreshQueueSnapshot } from "./state/queueState";
import { geminiCache } from "./services/gemini/geminiCache";
import { initDb, closeDb } from "./state/db";
import { scheduleDripPublisher } from "./core/dripPublisher";
import { scheduleCrmSync } from "./core/crmSync";
import { scheduleRankTracking } from "./core/rankTracking";
import { schedulePromotionCron } from "./core/promotionScan";
import { scheduleCookieAutoRefresh } from "./services/fourseller/autoRefresh";
import { acquireInstanceLock } from "./state/singleInstance";

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

let releaseLock: (() => void) | null = null;

const bootstrap = async () => {
  // Giành khoá TRƯỚC mọi thứ khác. Bind port từng được dùng làm chốt chặn nhưng trên Windows
  // instance thứ hai vẫn bind "thành công" rồi lên lịch cron song song (xem singleInstance.ts).
  releaseLock = await acquireInstanceLock();
  await initDb(); // SQLite — phải init đầu tiên (auto-import legacy JSON)
  await Promise.all([historyStore.init(), geminiCache.init()]);
  refreshQueueSnapshot().catch(() => {});
  // startAdminServer reject nếu port đã bị chiếm (instance khác đang chạy).
  await startAdminServer();

  // Khôi phục file kẹt ở .processing (crash lần trước) về pending — chạy ở
  // single instance, trước khi cron bắt đầu.
  await recoverOrphanedProcessing().catch((e) =>
    console.warn("⚠️ recoverOrphanedProcessing lỗi:", e?.message ?? e)
  );

  // CHỈ lên lịch cron SAU KHI bind port thành công → đảm bảo chỉ 1 instance
  // chạy cron (chống double-publish do 2 worker song song).
  cron.schedule(config.cronFileRouter, runFileRouterOnce);
  cron.schedule(config.cronQueueManager, runQueueManagerOnce);
  console.log("⏰ Cron đã lên lịch (file router + queue manager).");

  // Drip-publish draft 4Seller nhỏ giọt (bật/tắt qua config/publish.json → enabled).
  scheduleDripPublisher();

  scheduleCrmSync();       // agent bridge KBT CRM: pull hiệu năng + push registry
  scheduleRankTracking();  // Apify bestseller rank
  schedulePromotionCron(); // cào promotion 4Seller (Flash/Discount) mỗi 2 giờ
  scheduleCookieAutoRefresh(); // cookie hết hạn → tự login lại (account đã lưu user/pass)
};
bootstrap().catch((err) => {
  console.error("❌ Bootstrap failed:", err?.message ?? err);
  releaseLock?.(); // chỉ nhả nếu CHÍNH mình đã giành được (hàm tự kiểm tra pid)
  process.exit(1); // instance thừa thoát hẳn, không chạy cron song song
});

// Thoát bình thường (không qua SIGINT/SIGTERM) vẫn phải nhả khoá, nếu không lần chạy sau
// sẽ thấy khoá của một PID đã chết.
process.on("exit", () => releaseLock?.());

const shutdown = (signal: string) => {
  console.log(`\n📴 Nhận ${signal}, dừng worker...`);
  releaseLock?.();
  closeDb();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
});
