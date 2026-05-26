import fs from "fs-extra";
import path from "path";
import crypto from "crypto";

/**
 * Persistent cache cho Gemini calls. Lưu vào data/cache/gemini.json,
 * key bằng SHA-256 hash của input (gọn, không phình file).
 *
 * Structure:
 *   {
 *     titles:     { <hash>: <output> },
 *     categories: { <hash>: <output> }
 *   }
 */

interface CacheFile {
  titles: Record<string, string>;
  categories: Record<string, string>;
}

const CACHE_DIR = path.resolve(process.cwd(), "data", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "gemini.json");

let cache: CacheFile = { titles: {}, categories: {} };
let loaded = false;
let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;

const hashKey = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);

const load = async (): Promise<void> => {
  if (loaded) return;
  loaded = true;
  await fs.ensureDir(CACHE_DIR);
  if (await fs.pathExists(CACHE_FILE)) {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      cache = {
        titles: parsed.titles ?? {},
        categories: parsed.categories ?? {},
      };
      const tCount = Object.keys(cache.titles).length;
      const cCount = Object.keys(cache.categories).length;
      console.log(`💾 Gemini cache loaded: ${tCount} titles, ${cCount} categories`);
    } catch (err) {
      console.warn("⚠️ Không đọc được gemini.json cache, dùng cache trống:", err);
      cache = { titles: {}, categories: {} };
    }
  }
};

const scheduleSave = (): void => {
  dirty = true;
  if (saveTimer) return;
  // Debounce 1s: tránh write disk liên tục khi cache nhiều entry cùng lúc
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await fs.ensureDir(CACHE_DIR);
      await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch (err) {
      console.warn("⚠️ Không ghi được gemini.json:", err);
    }
  }, 1000);
};

const normalize = (s: string): string => s.trim().toLowerCase();

export const geminiCache = {
  async init(): Promise<void> {
    await load();
  },

  async getTitle(input: string): Promise<string | null> {
    await load();
    return cache.titles[hashKey(normalize(input))] ?? null;
  },

  async setTitle(input: string, output: string): Promise<void> {
    await load();
    if (!output) return;
    cache.titles[hashKey(normalize(input))] = output;
    scheduleSave();
  },

  async getCategory(input: string): Promise<string | null> {
    await load();
    return cache.categories[hashKey(normalize(input))] ?? null;
  },

  async setCategory(input: string, output: string): Promise<void> {
    await load();
    if (!output) return;
    cache.categories[hashKey(normalize(input))] = output;
    scheduleSave();
  },

  stats(): { titles: number; categories: number } {
    return {
      titles: Object.keys(cache.titles).length,
      categories: Object.keys(cache.categories).length,
    };
  },

  async clear(kind?: "titles" | "categories"): Promise<void> {
    await load();
    if (!kind) {
      cache = { titles: {}, categories: {} };
    } else {
      cache[kind] = {};
    }
    scheduleSave();
  },
};
