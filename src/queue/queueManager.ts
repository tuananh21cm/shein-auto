import * as fs from "fs-extra";
import * as path from "path";
import { workerConfig } from "../config/appConfig";
import { listing4sellerShein } from "../core/listing4sellerShein";
import { getProfileNameFromFolder } from "../core/steps/randomUtils";
import { workerState } from "../state/workerState";
import { refreshQueueSnapshot } from "../state/queueState";
import { historyStore } from "../state/historyStore";
import { notifyFail, notifySuccess } from "../services/notification/telegram";
import { getAllUserDirs, UserDirs } from "../state/userDirs";

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

const listShopFolders = async (baseDir: string, profiles: string[]): Promise<string[]> => {
  const entries = await fs.readdir(baseDir);
  const result: string[] = [];
  for (const name of entries) {
    if (name === "Success" || name === "Fail" || name.startsWith(".")) continue;
    // Nếu user có profiles, filter theo đó
    if (profiles.length > 0 && !profiles.includes(name)) continue;
    try {
      const stats = await fs.stat(path.join(baseDir, name));
      if (stats.isDirectory()) result.push(name);
    } catch {
      // bỏ qua
    }
  }
  return result.sort();
};

// Lock per (baseDir + folder) — cho phép parallel giữa các user/folder
const folderLocks = new Set<string>();
let runningCount = 0;

const lockKey = (baseDir: string, folder: string) => `${baseDir}::${folder}`;

const processOne = async (
  baseDir: string,
  folderName: string,
  owner: string
): Promise<void> => {
  const key = lockKey(baseDir, folderName);
  if (folderLocks.has(key)) return;
  folderLocks.add(key);
  runningCount++;

  const accountPath = path.join(baseDir, folderName);
  const oldestFile = await getOldestJsonFile(accountPath);

  try {
    if (!oldestFile) {
      console.log(`Không có file nào cần xử lý trong ${owner}/${folderName}.`);
      return;
    }

    console.log(`🚀 [${owner}/${folderName}] Chuẩn bị chạy: ${oldestFile}`);
    const profile = getProfileNameFromFolder(`${baseDir}/${folderName}/${oldestFile}`);
    const startedAt = Date.now();

    workerState.startJob({ file: oldestFile, profile, folder: folderName, startedAt });

    // listing4sellerShein cần đường dẫn tuyệt đối
    const absJsonPath = path.join(accountPath, oldestFile);
    const successDir = path.join(accountPath, "Success");
    const failDir = path.join(accountPath, "Fail");

    try {
      await listing4sellerShein(absJsonPath);
      await fs.ensureDir(successDir);
      await fs.move(absJsonPath, path.join(successDir, oldestFile), { overwrite: true });
      console.log(`✅ [${owner}/${folderName}] Hoàn thành: ${oldestFile}`);

      const finishedAt = Date.now();
      await historyStore.add({
        file: oldestFile,
        folder: folderName,
        profile,
        status: "success",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
      await notifySuccess({
        file: oldestFile,
        folder: folderName,
        profile,
        durationMs: finishedAt - startedAt,
      });
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);
      console.error(`❌ [${owner}/${folderName}] Lỗi khi đăng ${oldestFile}:`, err);

      try {
        await fs.ensureDir(failDir);
        await fs.move(absJsonPath, path.join(failDir, oldestFile), { overwrite: true });
        await fs.writeFile(
          path.join(failDir, `${oldestFile}.error.log`),
          `${new Date().toISOString()}\n\n${errorMessage}\n\n${err?.stack ?? ""}`,
          "utf-8"
        );
        console.log(`📁 [${owner}/${folderName}] Đã chuyển vào Fail: ${oldestFile}`);
      } catch (moveErr) {
        console.error(`⚠️ [${owner}/${folderName}] Không thể move vào Fail:`, moveErr);
      }

      const finishedAt = Date.now();
      await historyStore.add({
        file: oldestFile,
        folder: folderName,
        profile,
        status: "fail",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        errorMessage,
      });
      await notifyFail({ file: oldestFile, folder: folderName, profile, errorMessage });
    } finally {
      workerState.finishJob(oldestFile);
    }
  } finally {
    folderLocks.delete(key);
    runningCount--;
    refreshQueueSnapshot().catch(() => {});
  }
};

/**
 * Pick file để chạy cho 1 user: round-robin trong baseDir, lưu state ở
 * <baseDir>/.last_folder.txt riêng cho mỗi user.
 */
const tickForUser = async (
  dirs: UserDirs,
  slotsAvailable: number
): Promise<number> => {
  const { username, baseSheinAutoDir, profiles } = dirs;
  if (slotsAvailable <= 0) return 0;
  if (!(await fs.pathExists(baseSheinAutoDir))) return 0;

  const folders = await listShopFolders(baseSheinAutoDir, profiles);
  if (folders.length === 0) return 0;

  // Read last folder cho user này
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
    processOne(baseSheinAutoDir, f, username).catch((err) => {
      console.error(`❌ processOne(${username}/${f}) crashed:`, err);
    });
  }

  if (lastPicked) {
    await fs.writeFile(lastFolderFile, lastPicked, "utf8").catch(() => {});
    workerState.setLastFolder(`${username}/${lastPicked}`);
  }

  return spawned;
};

export const runQueueManagerOnce = async (): Promise<void> => {
  const concurrency = Math.max(1, workerConfig().concurrency);

  if (runningCount >= concurrency) {
    console.log(`Đã đạt concurrency ${concurrency}, bỏ qua tick.`);
    return;
  }

  console.log(
    `\n--- [${new Date().toLocaleTimeString()}] CHECKING QUEUE (concurrency=${concurrency}, running=${runningCount}) ---`
  );

  await refreshQueueSnapshot();

  const allDirs = await getAllUserDirs();
  if (allDirs.length === 0) {
    console.log("Không có user nào có baseSheinAutoDir.");
    return;
  }

  let slotsLeft = concurrency - runningCount;
  // Round-robin giữa các user mỗi tick — không user nào bị starve
  for (const dirs of allDirs) {
    if (slotsLeft <= 0) break;
    const spawned = await tickForUser(dirs, slotsLeft);
    slotsLeft -= spawned;
  }
};
