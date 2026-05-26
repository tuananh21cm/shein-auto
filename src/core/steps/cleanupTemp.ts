import fs from "fs";
import path from "path";
import { promises as fsPromises } from "fs";

const QUARANTINE_DIR = path.join(process.cwd(), "temp_failed_cleanup");

/**
 * Xóa thư mục tạm với retry. Nếu quá nhiều lần thất bại thì move sang quarantine
 * để OS không tiếp tục báo lỗi (Chromium thường giữ file lock vài giây sau khi đóng).
 */
export const safeCleanupDir = (
  dirPath: string,
  label: string,
  maxRetries = 20,
  retryIntervalMs = 15000
) => {
  const attempt = async (count: number) => {
    if (!fs.existsSync(dirPath)) return;

    try {
      await fsPromises.rm(dirPath, { recursive: true, force: true });
      console.log(`🧹 [${label}] Đã dọn dẹp thư mục tạm (lần ${count}).`);
    } catch {
      if (count >= maxRetries) {
        console.warn(`⚠️ [${label}] Quá ${maxRetries} lần thất bại. Đưa vào quarantine...`);
        try {
          await fsPromises.mkdir(QUARANTINE_DIR, { recursive: true });
          const dest = path.join(QUARANTINE_DIR, path.basename(dirPath));
          await fsPromises.rename(dirPath, dest);
          console.log(`📦 [${label}] Đã chuyển sang: ${dest}`);
        } catch (qErr) {
          console.error(`❌ [${label}] Không thể quarantine:`, qErr);
        }
        return;
      }
      console.log(`⚠️ [${label}] File đang bận (lần ${count}/${maxRetries}), thử lại sau ${retryIntervalMs / 1000}s...`);
      setTimeout(() => attempt(count + 1), retryIntervalMs);
    }
  };

  setTimeout(() => attempt(1), 10000);
};
