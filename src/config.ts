import "dotenv/config";
import path from "path";
import { workerConfig } from "./config/appConfig";

const worker = workerConfig();

const envDownload = process.env.DOWNLOAD_DIR?.trim() ?? "";
const envBase = process.env.BASE_SHEINAUTO_DIR?.trim() ?? "";
const envHub = process.env.HUB_DIR?.trim() ?? "";

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  /** Default fallback cho user không cấu hình downloadDir riêng. Rỗng = user bắt buộc tự set. */
  downloadDir: envDownload ? path.normalize(envDownload) : "",
  /** Default fallback cho user không cấu hình baseSheinAutoDir riêng. Rỗng = user bắt buộc tự set. */
  baseSheinAutoDir: envBase ? path.normalize(envBase) : "",
  /** Hub sản phẩm — kho chung toàn hệ thống, NẰM NGOÀI baseDir user nên cron không quét. */
  hubDir: envHub ? path.normalize(envHub) : path.join(__dirname, "..", "data", "hub"),
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
if (!config.downloadDir && !config.baseSheinAutoDir) {
  console.warn(
    "⚠️ DOWNLOAD_DIR / BASE_SHEINAUTO_DIR chưa set trong .env — mỗi user cần tự cấu hình ở Admin UI > Users."
  );
}
