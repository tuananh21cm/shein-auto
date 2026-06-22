/**
 * Lưu snapshot demand Kalodata (TikTok US) theo ngày — tầng P3.
 */
import { getDb } from "./db";
import type { KaloCategory, KaloProduct } from "../services/kalodata/client";

export const kalodataStore = {
  saveCategories(day: string, items: KaloCategory[]): number {
    if (!items.length) return 0;
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO kalodata_category (
        day, cate_id, numeric_id, name, level, revenue, growth_rate, shop_number, avg_revenue,
        top3_ratio, top10_ratio, trend_slope, captured_at
      ) VALUES (@day,@cateId,@numericId,@name,@level,@revenue,@growthRate,@shopNumber,@avgRevenue,@top3Ratio,@top10Ratio,@trendSlope,@now)
      ON CONFLICT(day, cate_id) DO UPDATE SET
        numeric_id=excluded.numeric_id, revenue=excluded.revenue, growth_rate=excluded.growth_rate,
        shop_number=excluded.shop_number, avg_revenue=excluded.avg_revenue, top3_ratio=excluded.top3_ratio,
        top10_ratio=excluded.top10_ratio, trend_slope=excluded.trend_slope, captured_at=excluded.captured_at
    `);
    const tx = db.transaction((rows: KaloCategory[]) => {
      for (const c of rows) stmt.run({ day, now, ...c });
    });
    tx(items);
    return items.length;
  },

  saveProducts(day: string, items: KaloProduct[]): number {
    if (!items.length) return 0;
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO kalodata_product (
        day, product_id, title, revenue, sale, unit_price, commission_rate, product_rating,
        is_local, launch_date, creator_num, pri_cate_id, cate_filter, captured_at
      ) VALUES (@day,@productId,@title,@revenue,@sale,@unitPrice,@commissionRate,@rating,@isLocalInt,@launchDate,@creatorNum,@priCateId,@cateFilterVal,@now)
      ON CONFLICT(day, product_id) DO UPDATE SET
        revenue=excluded.revenue, sale=excluded.sale, unit_price=excluded.unit_price,
        commission_rate=excluded.commission_rate, product_rating=excluded.product_rating,
        is_local=excluded.is_local, creator_num=excluded.creator_num,
        cate_filter=COALESCE(excluded.cate_filter, kalodata_product.cate_filter), captured_at=excluded.captured_at
    `);
    const tx = db.transaction((rows: KaloProduct[]) => {
      for (const p of rows) stmt.run({ day, now, ...p, isLocalInt: p.isLocal === null ? null : p.isLocal ? 1 : 0, cateFilterVal: p.cateFilter ?? null });
    });
    tx(items);
    return items.length;
  },

  /** Lưu product theo từng category (drill-down). Mỗi product gắn cate_filter=tên ngách. */
  saveCategoryProducts(day: string, groups: { name: string; products: KaloProduct[] }[]): number {
    let n = 0;
    for (const g of groups) {
      const tagged = g.products.map((p) => ({ ...p, cateFilter: g.name }));
      n += this.saveProducts(day, tagged);
    }
    return n;
  },

  listProductsByCategory(day: string, cateName: string, limit = 30): KaloProduct[] {
    const rows = getDb().prepare(`
      SELECT * FROM kalodata_product WHERE day = ? AND cate_filter = ? ORDER BY revenue DESC LIMIT ?
    `).all(day, cateName, limit) as any[];
    return rows.map((r) => ({
      productId: r.product_id, title: r.title, revenue: r.revenue, sale: r.sale,
      unitPrice: r.unit_price, commissionRate: r.commission_rate, rating: r.product_rating,
      isLocal: r.is_local === null ? null : r.is_local === 1, launchDate: r.launch_date,
      creatorNum: r.creator_num, priCateId: r.pri_cate_id, cateFilter: r.cate_filter,
    }));
  },

  listCategories(day: string): KaloCategory[] {
    const rows = getDb().prepare(`SELECT * FROM kalodata_category WHERE day = ? ORDER BY revenue DESC`).all(day) as any[];
    return rows.map((r) => ({
      cateId: r.cate_id, numericId: r.numeric_id ?? null, name: r.name, level: r.level, revenue: r.revenue,
      growthRate: r.growth_rate, shopNumber: r.shop_number, avgRevenue: r.avg_revenue,
      top3Ratio: r.top3_ratio, top10Ratio: r.top10_ratio, trendSlope: r.trend_slope,
    }));
  },

  listProducts(day: string, limit = 100): KaloProduct[] {
    const rows = getDb().prepare(`SELECT * FROM kalodata_product WHERE day = ? ORDER BY revenue DESC LIMIT ?`).all(day, limit) as any[];
    return rows.map((r) => ({
      productId: r.product_id, title: r.title, revenue: r.revenue, sale: r.sale,
      unitPrice: r.unit_price, commissionRate: r.commission_rate, rating: r.product_rating,
      isLocal: r.is_local === null ? null : r.is_local === 1, launchDate: r.launch_date,
      creatorNum: r.creator_num, priCateId: r.pri_cate_id,
    }));
  },

  /** Ngày Kalodata mới nhất đã có (để demandFit dùng), hoặc null. */
  latestDay(): string | null {
    const r = getDb().prepare(`SELECT day FROM kalodata_category ORDER BY day DESC LIMIT 1`).get() as { day: string } | undefined;
    return r?.day ?? null;
  },

  listDays(limit = 30): string[] {
    const rows = getDb().prepare(`SELECT DISTINCT day FROM kalodata_category ORDER BY day DESC LIMIT ?`).all(limit) as { day: string }[];
    return rows.map((r) => r.day);
  },
};
