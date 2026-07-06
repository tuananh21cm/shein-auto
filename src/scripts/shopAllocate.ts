/**
 * shopAllocate — phân bổ sản phẩm win cho shop theo ngách (round-robin công bằng).
 * Đọc shop_niche → với mỗi ngách, lấy sp win (research_product, win>=70) → chia cho các shop
 * cùng ngách → ghi vào shop_allocation (PK (goods_id, shop) = 1 sp CÓ THỂ list cho NHIỀU shop).
 *
 * 1 sp được list tối đa maxShopsPerProduct shop (research.json; 0 = không giới hạn). Không list
 * lại sp đã có cho cùng shop (composite PK + IGNORE). imageRemake perShopSeed làm ảnh khác nhau.
 *
 * Usage: npx tsx src/scripts/shopAllocate.ts [target]   (target sp/shop, mặc định 100)
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { researchConfig } from "../config/appConfig";

const TARGET_DEFAULT = 100;
const WIN_MIN = 70;
const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = () => {
  const target = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : TARGET_DEFAULT;
  const capCfg = researchConfig().maxShopsPerProduct;
  const capN = typeof capCfg === "number" && capCfg > 0 ? capCfg : Infinity;
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));

  db.exec(`CREATE TABLE IF NOT EXISTS shop_allocation (
    goods_id TEXT NOT NULL,
    shop TEXT NOT NULL,
    niche_key TEXT,
    name TEXT, win_score INTEGER, opportunity_score INTEGER,
    price REAL, url TEXT, image TEXT,
    status TEXT DEFAULT 'allocated',
    allocated_at INTEGER, listed_at INTEGER,
    crawl_attempts INTEGER DEFAULT 0,
    PRIMARY KEY (goods_id, shop)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS excluded_products (goods_id TEXT PRIMARY KEY, reason TEXT, excluded_at INTEGER)`);

  // shop_niche → niche_key → [shop]
  const sn = db.prepare("SELECT shop, niche_key FROM shop_niche WHERE status != 'paused'").all() as any[];
  if (!sn.length) return out({ ok: false, error: "shop_niche trống — chưa gán ngách cho shop nào. Gán trước (xem skill)." });
  const byNiche: Record<string, string[]> = {};
  for (const r of sn) (byNiche[r.niche_key] ||= []).push(r.shop);

  // Trạng thái allocation hiện có (toàn cục): cặp (gid|shop) + số shop distinct/sp (cho cap).
  const existingPairs = new Set<string>();
  const shopCountByGid: Record<string, number> = {};
  for (const r of db.prepare("SELECT goods_id, shop FROM shop_allocation").all() as any[]) {
    const key = `${r.goods_id}|${r.shop}`;
    if (existingPairs.has(key)) continue;
    existingPairs.add(key);
    shopCountByGid[r.goods_id] = (shopCountByGid[r.goods_id] || 0) + 1;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shop_allocation (goods_id,shop,niche_key,name,win_score,opportunity_score,price,url,image,status,allocated_at)
     VALUES (@goods_id,@shop,@niche_key,@name,@win_score,@opportunity_score,@price,@url,@image,'allocated',@now)`
  );

  const report: any[] = [];
  const tx = db.transaction(() => {
    for (const [niche, shops] of Object.entries(byNiche)) {
      // sp win của ngách, gộp theo goods_id lấy bản tốt nhất, xếp opportunity giảm dần
      const prods = db.prepare(
        `SELECT goods_id, name, win_score, MAX(opportunity_score) opportunity_score, price, url, image
         FROM research_product WHERE niche_key=? AND win_score>=? AND goods_id IS NOT NULL
           AND goods_id NOT IN (SELECT goods_id FROM excluded_products)
         GROUP BY goods_id ORDER BY opportunity_score DESC`
      ).all(niche, WIN_MIN) as any[];

      const counts: Record<string, number> = {};
      for (const s of shops) {
        counts[s] = (db.prepare("SELECT COUNT(*) n FROM shop_allocation WHERE shop=? AND niche_key=?").get(s, niche) as any).n;
      }

      // Round-robin CÔNG BẰNG: mỗi vòng, từng shop (dưới target) nhận sp kế đủ điều kiện
      //   (chưa có ở shop đó + chưa đạt cap toàn cục). Lặp tới khi mọi shop đủ target / hết sp.
      const cursor: Record<string, number> = {}; for (const s of shops) cursor[s] = 0;
      const added: Record<string, number> = {};
      let progress = true;
      while (progress) {
        progress = false;
        for (const shop of shops) {
          if (counts[shop] >= target) continue;
          // tìm sp kế cho shop này
          let i = cursor[shop];
          for (; i < prods.length; i++) {
            const p = prods[i];
            const gid = p.goods_id;
            const pairKey = `${gid}|${shop}`;
            if (existingPairs.has(pairKey)) continue;             // shop đã có sp này
            if ((shopCountByGid[gid] || 0) >= capN) continue;      // sp đã đạt cap số shop
            // cấp phát
            insert.run({ ...p, shop, niche_key: niche, now: Date.now() });
            existingPairs.add(pairKey);
            shopCountByGid[gid] = (shopCountByGid[gid] || 0) + 1;
            counts[shop]++; added[shop] = (added[shop] || 0) + 1;
            progress = true;
            i++;
            break;
          }
          cursor[shop] = i;
        }
      }

      const capacity = capN === Infinity ? prods.length * shops.length : Math.min(prods.length * shops.length, prods.length * capN);
      for (const s of shops) {
        report.push({
          niche, shop: s, totalAllocated: counts[s], newlyAdded: added[s] || 0,
          targetGap: Math.max(0, target - counts[s]),
          supplyWin: prods.length,
          note: capacity < target * shops.length ? `⚠️ ngách ${prods.length} sp win (cap ${capN === Infinity ? "∞" : capN}/sp) — thiếu để đủ ${target}/shop, cần cron research thêm` : "đủ hàng",
        });
      }
    }
  });
  tx();

  db.close();
  out({ ok: true, target, maxShopsPerProduct: capN === Infinity ? 0 : capN, allocations: report });
};

main();
