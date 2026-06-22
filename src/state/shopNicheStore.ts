/**
 * shopNicheStore (Niche Lab P2) — gán ngách cho từng shop (danh mục 10 shop).
 * listedCount = số candidate ngách đó đã đẩy vào shop đó (research_candidate.target_shop).
 */
import { getDb } from "./db";

export type ShopNicheStatus = "testing" | "scaling" | "dropped";

export interface ShopNiche {
  shop: string;
  nicheKey: string;
  status: ShopNicheStatus;
  note: string | null;
  listed: number;        // số sp ngách này đã đẩy vào shop
  updatedAt: number;
}

export const shopNicheStore = {
  assign(shop: string, nicheKey: string): void {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO shop_niche (shop, niche_key, status, created_at, updated_at)
      VALUES (?, ?, 'testing', ?, ?)
      ON CONFLICT(shop, niche_key) DO NOTHING
    `).run(shop, nicheKey, now, now);
  },

  remove(shop: string, nicheKey: string): void {
    getDb().prepare(`DELETE FROM shop_niche WHERE shop = ? AND niche_key = ?`).run(shop, nicheKey);
  },

  setStatus(shop: string, nicheKey: string, status: ShopNicheStatus): void {
    getDb().prepare(`UPDATE shop_niche SET status = ?, updated_at = ? WHERE shop = ? AND niche_key = ?`)
      .run(status, Date.now(), shop, nicheKey);
  },

  /** Số sp 1 ngách đã đẩy (queued) vào 1 shop — cộng dồn mọi ngày. */
  listedCount(shop: string, nicheKey: string): number {
    const r = getDb().prepare(`
      SELECT COUNT(*) c FROM research_candidate
      WHERE target_shop = ? AND niche_key = ? AND status = 'queued'
    `).get(shop, nicheKey) as { c: number };
    return r.c;
  },

  /** Mọi gán ngách (kèm listed count). */
  listAll(): ShopNiche[] {
    const rows = getDb().prepare(`SELECT * FROM shop_niche ORDER BY shop, niche_key`).all() as any[];
    return rows.map((r) => ({
      shop: r.shop, nicheKey: r.niche_key, status: r.status as ShopNicheStatus,
      note: r.note ?? null, updatedAt: r.updated_at,
      listed: this.listedCount(r.shop, r.niche_key),
    }));
  },
};
