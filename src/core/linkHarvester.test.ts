import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { scoreAndInsertStore } from "./linkHarvester";
import type { StoreProduct } from "../services/kiki/storeCrawler";

/** DB in-memory tối thiểu cho scoreAndInsertStore (chỉ 2 bảng nó đọc/ghi). */
function memDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE shop_allocation (
      goods_id TEXT NOT NULL, shop TEXT NOT NULL, niche_key TEXT, name TEXT,
      win_score INTEGER, opportunity_score INTEGER, price REAL, url TEXT, image TEXT,
      status TEXT DEFAULT 'allocated', allocated_at INTEGER, listed_at INTEGER, crawl_attempts INTEGER DEFAULT 0,
      PRIMARY KEY (goods_id, shop)
    );
    CREATE TABLE excluded_products (goods_id TEXT PRIMARY KEY, reason TEXT, excluded_at INTEGER);
  `);
  return db;
}

/** Sp "khoẻ" (review/rating/discount cao) để chắc chắn qua chấm điểm; chỉ khác giá. */
const prod = (id: string, price: number | null): StoreProduct => ({
  goodsId: id, name: `women cami top ${id}`, image: "", url: "",
  price, retailPrice: price == null ? null : price * 3, // discount ~66%
  discountPct: 66, reviewCount: 5000, rating: 4.8,
} as any);

describe("scoreAndInsertStore — lọc giá + trần insert", () => {
  const insertedIds = (db: Database.Database) =>
    (db.prepare("SELECT goods_id, price FROM shop_allocation ORDER BY price").all() as any[]);

  it("chỉ nạp sp giá < maxPrice, loại >=, loại giá null", () => {
    const db = memDb();
    const products = [prod("100001", 10), prod("100002", 17.99), prod("100003", 18), prod("100004", 25), prod("100005", null)];
    // minOpp=0 → mọi sp qua ngưỡng điểm; chỉ bộ lọc giá quyết định.
    const n = scoreAndInsertStore("ShopA", "cami-top", "cami top", "", products, 0, [], () => {}, 18, Infinity, db);
    const rows = insertedIds(db);
    expect(rows.map((r) => r.goods_id).sort()).toEqual(["100001", "100002"]); // chỉ 10 & 17.99
    expect(n).toBe(2);
    expect(rows.every((r) => r.price < 18)).toBe(true);
  });

  it("không giới hạn giá (Infinity) → chỉ chặn bởi trần limit", () => {
    const db = memDb();
    const products = [prod("200001", 5), prod("200002", 30), prod("200003", 99), prod("200004", 12)];
    const n = scoreAndInsertStore("ShopB", "cami-top", "cami top", "", products, 0, [], () => {}, Infinity, 2, db);
    expect(n).toBe(2);                     // trần 2
    expect(insertedIds(db).length).toBe(2);
  });

  it("trần limit=0 → không nạp gì", () => {
    const db = memDb();
    const n = scoreAndInsertStore("ShopC", "cami-top", "cami top", "", [prod("300001", 5)], 0, [], () => {}, 18, 0, db);
    expect(n).toBe(0);
    expect(insertedIds(db).length).toBe(0);
  });

  it("không nạp lại sp đã có cho shop (dedupe)", () => {
    const db = memDb();
    db.prepare("INSERT INTO shop_allocation (goods_id, shop, status) VALUES ('400001','ShopD','crawled')").run();
    const n = scoreAndInsertStore("ShopD", "cami-top", "cami top", "", [prod("400001", 5), prod("400002", 6)], 0, [], () => {}, 18, Infinity, db);
    expect(n).toBe(1); // chỉ 400002 (400001 đã có)
    expect(insertedIds(db).map((r) => r.goods_id)).toContain("400002");
  });
});
