import "dotenv/config";
import path from "path";
import { workerConfig } from "./config/appConfig";

const worker = workerConfig();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  downloadDir: path.normalize(process.env.DOWNLOAD_DIR ?? "C:/Users/KBT/Downloads"),
  baseSheinAutoDir: path.normalize(process.env.BASE_SHEINAUTO_DIR ?? "C:/Users/KBT/Downloads/SheinAuto"),
  cronFileRouter: process.env.CRON_FILE_ROUTER || worker.fileRouterCron,
  cronQueueManager: process.env.CRON_QUEUE_MANAGER || worker.queueManagerCron,
  cookieFile: path.join(__dirname, "cookies", "listing4sellerCookie.json"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
};

if (!config.geminiApiKey) {
  console.warn("⚠️ GEMINI_API_KEY chưa set — title/category AI sẽ fail.");
}
if (!config.telegramBotToken || !config.telegramChatId) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID chưa set — notification sẽ bị bỏ qua.");
}
