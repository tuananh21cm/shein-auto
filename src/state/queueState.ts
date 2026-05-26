import fs from "fs-extra";
import path from "path";
import { config } from "../config";
import { eventBus } from "./eventBus";

export interface QueueFolder {
  name: string;
  pendingCount: number;
  oldestFile: string | null;
}

export interface QueueSnapshot {
  folders: QueueFolder[];
  updatedAt: number;
}

let cache: QueueSnapshot = { folders: [], updatedAt: 0 };

/**
 * Scan baseSheinAutoDir, đếm số JSON pending mỗi folder shop.
 * Bỏ qua Success/Fail/dotfiles.
 */
export const refreshQueueSnapshot = async (): Promise<QueueSnapshot> => {
  const folders: QueueFolder[] = [];

  if (!(await fs.pathExists(config.baseSheinAutoDir))) {
    cache = { folders: [], updatedAt: Date.now() };
    eventBus.emit("queue", cache);
    return cache;
  }

  const entries = await fs.readdir(config.baseSheinAutoDir);
  for (const name of entries) {
    if (name === "Success" || name === "Fail" || name.startsWith(".")) continue;
    const fullPath = path.join(config.baseSheinAutoDir, name);
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) continue;

      const files = await fs.readdir(fullPath);
      const jsons = files.filter((f) => f.toLowerCase().endsWith(".json"));
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const f of jsons) {
        const s = await fs.stat(path.join(fullPath, f));
        if (s.birthtimeMs < oldestTime) {
          oldestTime = s.birthtimeMs;
          oldest = f;
        }
      }
      folders.push({ name, pendingCount: jsons.length, oldestFile: oldest });
    } catch {
      // skip
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  cache = { folders, updatedAt: Date.now() };
  eventBus.emit("queue", cache);
  return cache;
};

export const getQueueSnapshot = (): QueueSnapshot => cache;
