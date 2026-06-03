/**
 * Đọc/ghi config Kiki (config/kiki.json). apiBase ưu tiên env KIKI_API.
 */
import fs from "fs-extra";
import path from "path";

const KIKI_FILE = path.resolve(process.cwd(), "config", "kiki.json");

export interface KikiProfile {
  id: string;
  name: string;
}
export interface KikiConfig {
  apiBase: string;
  profiles: KikiProfile[];
}

const DEFAULTS: KikiConfig = { apiBase: "http://localhost:8000", profiles: [] };

export function readKikiConfig(): KikiConfig {
  try {
    const raw = fs.readFileSync(KIKI_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      apiBase: parsed.apiBase || DEFAULTS.apiBase,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function kikiApiBase(): string {
  return process.env.KIKI_API?.trim() || readKikiConfig().apiBase;
}

export async function saveKikiProfiles(profiles: KikiProfile[]): Promise<void> {
  const cfg = readKikiConfig();
  cfg.profiles = profiles;
  await fs.writeFile(KIKI_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}
