import fs from "fs-extra";
import path from "path";

/**
 * Cache stale-while-revalidate + persist ra đĩa.
 *  - getOrRefresh: trả data cache NGAY (kể cả hết hạn) → user không bao giờ đợi 4Seller;
 *    nếu stale → refresh nền (không await). Chưa có cache lần đầu → await 1 lần.
 *  - forceRefresh: cron warm nền gọi để luôn giữ cache tươi.
 *  - Persist ra data/cache/<name>.json → sống qua restart (không cold storm sau restart).
 */
interface Entry<T> { ts: number; data: T; }

export class SwrCache<T> {
  private mem = new Map<string, Entry<T>>();
  private inflight = new Set<string>();
  private file: string;
  private ttl: number;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(name: string, ttlMs: number) {
    this.ttl = ttlMs;
    this.file = path.join(process.cwd(), "data", "cache", `${name}.json`);
    try {
      const raw = fs.readJsonSync(this.file);
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) this.mem.set(k, v as Entry<T>);
    } catch { /* chưa có / hỏng → bỏ qua */ }
  }

  private persist(): void {
    if (this.saveTimer) return; // debounce 1s
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const obj: Record<string, Entry<T>> = {};
      for (const [k, v] of this.mem) obj[k] = v;
      fs.ensureDir(path.dirname(this.file)).then(() => fs.writeJson(this.file, obj)).catch(() => {});
    }, 1000);
  }

  get(key: string): T | undefined { return this.mem.get(key)?.data; }
  clear(): void { this.mem.clear(); this.persist(); }
  private fresh(key: string): boolean { const e = this.mem.get(key); return !!e && Date.now() - e.ts < this.ttl; }
  set(key: string, data: T): void { this.mem.set(key, { ts: Date.now(), data }); this.persist(); }

  private bgRefresh(key: string, fn: () => Promise<T>): void {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    fn().then((d) => this.set(key, d)).catch(() => {}).finally(() => this.inflight.delete(key));
  }

  /** Trả cache ngay (kể cả stale) + refresh nền nếu stale. Lần đầu chưa có cache → await. */
  async getOrRefresh(key: string, fn: () => Promise<T>): Promise<T> {
    const e = this.mem.get(key);
    if (e) { if (!this.fresh(key)) this.bgRefresh(key, fn); return e.data; }
    const data = await fn();
    this.set(key, data);
    return data;
  }

  /** Cron warm: ép tính lại + set (giữ cache luôn tươi). Không await lỗi. */
  async forceRefresh(key: string, fn: () => Promise<T>): Promise<void> {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try { this.set(key, await fn()); } catch { /* giữ cache cũ */ } finally { this.inflight.delete(key); }
  }
}
