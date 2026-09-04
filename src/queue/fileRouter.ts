import * as fs from "fs-extra";
import * as path from "path";
import { getAllUsersForCron, getEffectiveSettings } from "../state/userDirs";
import { workerConfig, isAutoCronOn } from "../config/appConfig";

const FILE_PATTERN = /^(P\d-\d{3}(?:_[A-Z]{2})?).*\.json$/i;

/**
 * Quét downloadDir của TỪNG user, nhận diện file JSON dạng P5-XXX hoặc P5-XXX_DE,
 * và move vào baseSheinAutoDir/<prefix>/ của user đó.
 *
 * Nếu file thuộc 1 shop trong profiles của user → move. Nếu profiles rỗng → move tất cả.
 */
export async function runFileRouterOnce(): Promise<void> {
  if (!isAutoCronOn()) return; // master-switch đọc tươi từ file (tắt là dừng ngay)
  try {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] QUÉT FILE DOWNLOADS SHEIN ---`);

    const userDirs = await getAllUsersForCron();
    if (userDirs.length === 0) {
      console.log("Không có user nào cấu hình thư mục.");
      return;
    }

    let totalMoved = 0;

    for (const dirs of userDirs) {
      const { username, downloadDir, baseSheinAutoDir, profiles } = dirs;

      // Per-user autoCron — file router cũng phải tôn trọng preference
      const effective = await getEffectiveSettings(username);
      if (!effective.autoCron) continue;

      if (!(await fs.pathExists(downloadDir))) continue;

      const files = await fs.readdir(downloadDir);
      let movedForUser = 0;

      for (const fileName of files) {
        const match = fileName.match(FILE_PATTERN);
        if (!match) continue;

        const prefixName = match[1];
        // Nếu user khai báo profiles, chỉ move các shop trong list
        if (profiles.length > 0 && !profiles.includes(prefixName)) continue;

        const sourcePath = path.join(downloadDir, fileName);
        const destFolder = path.join(baseSheinAutoDir, prefixName);
        const destPath = path.join(destFolder, fileName);

        try {
          await fs.ensureDir(destFolder);
          await fs.move(sourcePath, destPath, { overwrite: true });
          console.log(`   ✅ [${username}] Moved: ${fileName} → ${prefixName}/`);
          movedForUser++;
        } catch (moveErr) {
          console.error(`   ⚠️ [${username}] Lỗi di chuyển ${fileName}:`, moveErr);
        }
      }

      if (movedForUser > 0) {
        console.log(`   [${username}] Đã move ${movedForUser} file`);
        totalMoved += movedForUser;
      }
    }

    if (totalMoved > 0) console.log(`--- Tổng cộng đã di chuyển ${totalMoved} file. ---`);
  } catch (error) {
    console.error("❌ File Router Error:", error);
  }
}
