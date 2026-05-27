import * as fs from "fs-extra";
import * as path from "path";
import { workerConfig } from "../config/appConfig";
import { listing4sellerShein } from "../core/listing4sellerShein";
import { getProfileNameFromFolder } from "../core/steps/randomUtils";
import { workerState } from "../state/workerState";
import { refreshQueueSnapshot } from "../state/queueState";
import { historyStore } from "../state/historyStore";
import { notifyFail } from "../services/notification/telegram";
import { getAllUsersForCron, UserDirs, getEffectiveSettings } from "../state/userDirs";
import { loadAdminConfig } from "../adminConfig";

const LAST_FOLDER_FILE_NAME = ".last_folder.txt";

const getOldestJsonFile = async (dir: string): Promise<string | null> => {
  try {
    const files = await fs.readdir(dir);
    const jsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));
    if (jsonFiles.length === 0) return null;

    let oldestFile = "";
    let oldestTime = Infinity;
    for (const file of jsonFiles) {
      const stats = await fs.stat(path.join(dir, file));
      if (stats.birthtimeMs < oldestTime) {
        oldestTime = stats.birthtimeMs;
        oldestFile = file;
      }
    }
    return oldestFile;
  } catch {
    return null;
  }
};

/**
 * Liệt kê shop folders trong baseDir mà user hiện tại được phép cron:
 *  - profiles non-empty → đúng list trong profiles
 *  - profiles empty (catch-all) → tất cả shop NHƯNG loại shops đã được user khác claim
 *    (tránh admin với profiles=[] cướp shop của test)
 */
const listShopFolders = async (
  baseDir: string,
  profiles: string[],
  claimedByOthers: Set<string>
): Promise<string[]> => {
  const entries = await fs.readdir(baseDir);
  const result: string[] = [];
  for (const name of entries) {
    if (name === "Success" || name === "Fail" || name.startsWith(".")) continue;
    if (profiles.length > 0) {
      if (!profiles.includes(name)) continue;
    } else {
      // Empty profiles = catch-all, nhưng không touch shop của user khác
      if (claimedByOthers.has(name)) continue;
    }
    try {
      const stats = await fs.stat(path.join(baseDir, name));
      if (stats.isDirectory()) result.push(name);
    } catch {
      // bỏ qua
    }
  }
  return result.sort();
};

// Lock per (baseDir + folder) — parallel giữa các user/folder
const folderLocks = new Set<string>();
let runningCount = 0;

const lockKey = (baseDir: string, folder: string) => `${baseDir}::${folder}`;

/**
 * Process 1 file JSON cụ thể qua worker. Cập nhật state, history, notify, move file.
 * Có thể gọi từ cron (qua processOne) hoặc gọi trực tiếp từ adminServer (run-now).
 *
 * Returns true nếu chạy, false nếu folder đang lock (skip).
 */
export const processFile = async (
  baseDir: string,
  folderName: string,
  fileName: string,
  owner: string
): Promise<boolean> => {
  const key = lockKey(baseDir, folderName);
  if (folderLocks.has(key)) {
    console.log(`⏸️ [${owner}/${folderName}] đang lock, skip ${fileName}`);
    return false;
  }
  folderLocks.add(key);
  runningCount++;

  const accountPath = path.join(baseDir, folderName);
  const absJsonPath = path.join(accountPath, fileName);
  const successDir = path.join(accountPath, "Success");
  const failDir = path.join(accountPath, "Fail");

  if (!(await fs.pathExists(absJsonPath))) {
    console.warn(`⚠️ [${owner}/${folderName}] File không còn ở pending: ${fileName}`);
    folderLocks.delete(key);
    runningCount--;
    return false;
  }

  const profile = getProfileNameFromFolder(absJsonPath);
  const startedAt = Date.now();
  console.log(`🚀 [${owner}/${folderName}] Chạy: ${fileName}`);
  workerState.startJob({ file: fileName, profile, folder: folderName, startedAt });

  // Track xem listing4sellerShein có publish thành công không (tách khỏi move success)
  let publishOk = false;
  let publishError: any = null;

  try {
    try {
      // Mỗi owner có cookie 4Seller riêng (data/cookies/<owner>.json).
      // Owner có thể dạng "userA,userB" do dedup baseDir → lấy user đầu.
      const primaryOwner = owner.split(",")[0];
      const effective = await getEffectiveSettings(primaryOwner);
      await listing4sellerShein(absJsonPath, {
        cookieUser: primaryOwner,
        headless: effective.headless,
        pricing: effective.pricing,
      });
      publishOk = true; // publish thành công trên 4Seller
    } catch (err: any) {
      publishOk = false;
      publishError = err;
    }

    if (publishOk) {
      // Move file to Success — nhưng nếu file đã bị move/delete bên ngoài
      // (user click Retry/Delete trên UI giữa chừng), KHÔNG đảo ngược success.
      try {
        await fs.ensureDir(successDir);
        if (await fs.pathExists(absJsonPath)) {
          await fs.move(absJsonPath, path.join(successDir, fileName), { overwrite: true });
        } else {
          console.warn(
            `⚠️ [${owner}/${folderName}] File "${fileName}" đã bị move/delete bên ngoài trong khi worker chạy. Publish vẫn OK, skip move.`
          );
        }
      } catch (mvErr: any) {
        console.warn(
          `⚠️ [${owner}/${folderName}] Không move được vào Success (publish vẫn OK):`,
          mvErr?.message ?? mvErr
        );
      }
      console.log(`✅ [${owner}/${folderName}] Hoàn thành: ${fileName}`);

      const finishedAt = Date.now();
      await historyStore.add({
        file: fileName,
        folder: folderName,
        profile,
        status: "success",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
      // Không bắn Telegram khi success — chỉ notify khi fail (user request)
    } else {
      // Listing thật sự fail
      const errorMessage = publishError?.message ?? String(publishError);
      console.error(`❌ [${owner}/${folderName}] Lỗi khi đăng ${fileName}:`, publishError);
      try {
        await fs.ensureDir(failDir);
        if (await fs.pathExists(absJsonPath)) {
          await fs.move(absJsonPath, path.join(failDir, fileName), { overwrite: true });
          await fs.writeFile(
            path.join(failDir, `${fileName}.error.log`),
            `${new Date().toISOString()}\n\n${errorMessage}\n\n${publishError?.stack ?? ""}`,
            "utf-8"
          );
          console.log(`📁 [${owner}/${folderName}] Đã chuyển vào Fail: ${fileName}`);
        } else {
          console.warn(`⚠️ [${owner}/${folderName}] File "${fileName}" không còn ở pending để move vào Fail.`);
        }
      } catch (moveErr: any) {
        console.error(`⚠️ [${owner}/${folderName}] Không thể move vào Fail:`, moveErr?.message ?? moveErr);
      }
      const finishedAt = Date.now();
      await historyStore.add({
        file: fileName,
        folder: folderName,
        profile,
        status: "fail",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        errorMessage,
      });
      await notifyFail({ file: fileName, folder: folderName, profile, errorMessage });
    }
  } finally {
    workerState.finishJob(fileName);
    folderLocks.delete(key);
    runningCount--;
    refreshQueueSnapshot().catch(() => {});
  }
  return true;
};

/**
 * Cron mode: pick oldest file trong folder rồi gọi processFile.
 */
const processOldestInFolder = async (
  baseDir: string,
  folderName: string,
  owner: string
): Promise<void> => {
  const oldestFile = await getOldestJsonFile(path.join(baseDir, folderName));
  if (!oldestFile) {
    console.log(`Không có file nào trong ${owner}/${folderName}.`);
    return;
  }
  await processFile(baseDir, folderName, oldestFile, owner);
};

const tickForUser = async (dirs: UserDirs, slotsAvailable: number): Promise<number> => {
  const { username, baseSheinAutoDir, profiles } = dirs;
  if (slotsAvailable <= 0) return 0;
  if (!(await fs.pathExists(baseSheinAutoDir))) return 0;

  // Per-user autoCron override: nếu user tắt → skip user này khỏi cron
  const effective = await getEffectiveSettings(username);
  if (!effective.autoCron) {
    console.log(`⏸️  Skip ${username} (autoCron OFF)`);
    return 0;
  }

  // Build set shops đã được user khác claim explicit (qua profiles).
  // Khi current user có empty profiles, không được lấn các shop này.
  const cfg = await loadAdminConfig();
  const claimedByOthers = new Set<string>();
  for (const u of cfg.users) {
    if (u.username === username) continue;
    for (const shop of u.profiles ?? []) claimedByOthers.add(shop);
  }

  const folders = await listShopFolders(baseSheinAutoDir, profiles, claimedByOthers);
  if (folders.length === 0) return 0;

  const lastFolderFile = path.join(baseSheinAutoDir, LAST_FOLDER_FILE_NAME);
  let lastFolder: string | null = null;
  try {
    lastFolder = (await fs.readFile(lastFolderFile, "utf8")).trim();
  } catch {
    // chưa có
  }

  const startIdx = lastFolder ? Math.max(0, folders.indexOf(lastFolder)) + 1 : 0;
  const ordered: string[] = [];
  for (let i = 0; i < folders.length; i++) {
    ordered.push(folders[(startIdx + i) % folders.length]);
  }

  let spawned = 0;
  let lastPicked: string | null = null;
  for (const f of ordered) {
    if (spawned >= slotsAvailable) break;
    const key = lockKey(baseSheinAutoDir, f);
    if (folderLocks.has(key)) continue;
    const oldest = await getOldestJsonFile(path.join(baseSheinAutoDir, f));
    if (!oldest) continue;

    lastPicked = f;
    spawned++;
    processOldestInFolder(baseSheinAutoDir, f, username).catch((err) => {
      console.error(`❌ tick ${username}/${f} crashed:`, err);
    });
  }

  if (lastPicked) {
    await fs.writeFile(lastFolderFile, lastPicked, "utf8").catch(() => {});
    workerState.setLastFolder(`${username}/${lastPicked}`);
  }
  return spawned;
};

export const runQueueManagerOnce = async (): Promise<void> => {
  if (!workerConfig().autoCron) return; // user đã tắt auto cron

  const concurrency = Math.max(1, workerConfig().concurrency);
  if (runningCount >= concurrency) {
    console.log(`Đã đạt concurrency ${concurrency}, bỏ qua tick.`);
    return;
  }

  console.log(
    `\n--- [${new Date().toLocaleTimeString()}] CHECKING QUEUE (concurrency=${concurrency}, running=${runningCount}) ---`
  );

  await refreshQueueSnapshot();

  const allDirs = await getAllUsersForCron();
  if (allDirs.length === 0) {
    console.log("Không có user nào có baseSheinAutoDir.");
    return;
  }

  let slotsLeft = concurrency - runningCount;
  for (const dirs of allDirs) {
    if (slotsLeft <= 0) break;
    const spawned = await tickForUser(dirs, slotsLeft);
    slotsLeft -= spawned;
  }
};

/** Status getter cho adminServer/dashboard. */
export const queueRunningCount = (): number => runningCount;
