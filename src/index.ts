import cron from "node-cron";
import { config } from "./config";
import { runFileRouterOnce } from "./queue/fileRouter";
import { runQueueManagerOnce } from "./queue/queueManager";
import { startAdminServer } from "./adminServer";
import { installConsoleTap } from "./state/eventBus";
import { historyStore } from "./state/historyStore";
import { refreshQueueSnapshot } from "./state/queueState";
import { geminiCache } from "./services/gemini/geminiCache";
import { initDb, closeDb } from "./state/db";

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
  await startAdminServer();
};
bootstrap().catch((err) => {
  console.error("❌ Bootstrap failed:", err);
});

cron.schedule(config.cronFileRouter, runFileRouterOnce);
cron.schedule(config.cronQueueManager, runQueueManagerOnce);

const shutdown = (signal: string) => {
  console.log(`\n📴 Nhận ${signal}, dừng worker...`);
  closeDb();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
});
