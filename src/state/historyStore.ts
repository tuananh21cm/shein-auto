import fs from "fs-extra";
import path from "path";
import { eventBus } from "./eventBus";

export type HistoryStatus = "success" | "fail";

export interface HistoryEntry {
  id: string;
  file: string;
  folder: string;
  profile: string;
  status: HistoryStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  errorMessage?: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const MAX_ENTRIES = 500;

let entries: HistoryEntry[] = [];
let loaded = false;

const ensureLoaded = async (): Promise<void> => {
  if (loaded) return;
  loaded = true;
  await fs.ensureDir(DATA_DIR);
  try {
    if (await fs.pathExists(HISTORY_FILE)) {
      const raw = await fs.readFile(HISTORY_FILE, "utf-8");
      entries = JSON.parse(raw) as HistoryEntry[];
    }
  } catch (err) {
    console.warn("⚠️ Không đọc được history.json:", err);
    entries = [];
  }
};

const persist = async (): Promise<void> => {
  await fs.ensureDir(DATA_DIR);
  await fs.writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2), "utf-8");
};

export const historyStore = {
  async init(): Promise<void> {
    await ensureLoaded();
  },

  async add(entry: Omit<HistoryEntry, "id">): Promise<HistoryEntry> {
    await ensureLoaded();
    const id = `${entry.finishedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const full: HistoryEntry = { id, ...entry };
    entries.unshift(full);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
    await persist();
    eventBus.emit("history", full);
    return full;
  },

  async list(opts?: {
    status?: HistoryStatus;
    folder?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: HistoryEntry[]; total: number }> {
    await ensureLoaded();
    let filtered = entries;
    if (opts?.status) filtered = filtered.filter((e) => e.status === opts.status);
    if (opts?.folder) filtered = filtered.filter((e) => e.folder === opts.folder);
    const total = filtered.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return { items: filtered.slice(offset, offset + limit), total };
  },

  async find(id: string): Promise<HistoryEntry | null> {
    await ensureLoaded();
    return entries.find((e) => e.id === id) ?? null;
  },

  async clear(): Promise<void> {
    entries = [];
    await persist();
  },
};
