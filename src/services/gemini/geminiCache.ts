import crypto from "crypto";
import { getDb } from "../../state/db";

const hashKey = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);

const normalize = (s: string): string => s.trim().toLowerCase();

type Kind = "title" | "category" | "analysis";

const get = (kind: Kind, input: string): string | null => {
  const db = getDb();
  const row = db
    .prepare("SELECT output FROM gemini_cache WHERE kind = ? AND cache_key = ?")
    .get(kind, hashKey(normalize(input))) as { output: string } | undefined;
  return row?.output ?? null;
};

const set = (kind: Kind, input: string, output: string): void => {
  if (!output) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO gemini_cache (kind, cache_key, output, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, cache_key) DO UPDATE SET output = excluded.output, created_at = excluded.created_at
  `).run(kind, hashKey(normalize(input)), output, Date.now());
};

export const geminiCache = {
  async init(): Promise<void> {
    getDb(); // lazy connect
    const stats = this.stats();
    console.log(`💾 Gemini cache: ${stats.titles} titles, ${stats.categories} categories`);
  },

  async getTitle(input: string): Promise<string | null> {
    return get("title", input);
  },

  async setTitle(input: string, output: string): Promise<void> {
    set("title", input, output);
  },

  async getCategory(input: string): Promise<string | null> {
    return get("category", input);
  },

  async setCategory(input: string, output: string): Promise<void> {
    set("category", input, output);
  },

  async getAnalysis(input: string): Promise<string | null> {
    return get("analysis", input);
  },

  async setAnalysis(input: string, output: string): Promise<void> {
    set("analysis", input, output);
  },

  stats(): { titles: number; categories: number } {
    const db = getDb();
    const t = db.prepare("SELECT COUNT(*) as c FROM gemini_cache WHERE kind = 'title'").get() as { c: number };
    const c = db.prepare("SELECT COUNT(*) as c FROM gemini_cache WHERE kind = 'category'").get() as { c: number };
    return { titles: t.c, categories: c.c };
  },

  async clear(kind?: Kind): Promise<void> {
    const db = getDb();
    if (kind) db.prepare("DELETE FROM gemini_cache WHERE kind = ?").run(kind);
    else db.prepare("DELETE FROM gemini_cache").run();
  },
};
