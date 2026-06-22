/**
 * researchGraphicTees — MỞ RỘNG pool oversized-tee bằng các keyword GRAPHIC (họa tiết khác biệt),
 * né áo trơn bão hòa. Dùng lại đúng máy chấm điểm của dailyResearch:
 *   searchProducts (RapidAPI US) → scoreWin → rollupNiche → scoreOpportunity → researchStore.saveProducts
 * Tất cả lưu vào niche_key='oversized-tee', source='shein-graphic-search'.
 *
 * Usage: npx tsx src/scripts/researchGraphicTees.ts [--apply] [perPage]
 *   (không --apply = chỉ search + in thống kê, KHÔNG ghi DB)
 */
import "dotenv/config";
import { searchProducts } from "../services/shein/client";
import { scoreWin, type WinScored } from "../core/winScore";
import { rollupNiche } from "../core/research/nicheScore";
import { scoreOpportunity } from "../core/research/opportunityScore";
import { researchStore, today, type ProductSnapshot } from "../state/researchStore";
import Database from "better-sqlite3";
import path from "path";

const apply = process.argv.includes("--apply");
const perPage = Number(process.argv.find((a) => /^\d+$/.test(a))) || 40;

// Keyword graphic — mỗi cái nhắm 1 kiểu họa tiết khác biệt (tránh "solid"/"plain"/"basic").
const KEYWORDS = [
  "floral graphic oversized tee women",
  "tropical hibiscus print t-shirt women",
  "vintage band graphic tee women oversized",
  "animal print graphic tee women",
  "butterfly graphic oversized tshirt women",
  "slogan letter print oversized tee women",
  "retro 90s washed graphic tee women",
  "abstract art print oversized tshirt women",
  "cartoon graphic tee women oversized",
  "western cowgirl graphic tee women",
  "aesthetic y2k graphic tee women oversized",
  "fruit cherry lemon print tee women",
  "ocean beach graphic oversized tee women",
  "angel number star graphic tee women",
  "coquette bow graphic tee women oversized",
];

const NICHE_KEY = "oversized-tee";
const NICHE_GROUP = "fashion-tops";
const SOURCE = "shein-graphic-search";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const day = today();
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const existing = new Set(
    db.prepare("SELECT DISTINCT goods_id FROM research_product WHERE niche_key=?").all(NICHE_KEY).map((r: any) => String(r.goods_id))
  );
  db.close();
  console.log(`Pool oversized-tee hiện có ${existing.size} goods_id. Tìm thêm graphic qua ${KEYWORDS.length} keyword…\n`);

  // gom toàn bộ win-scored để rollup nhiệt chung (1 ngách)
  const allWins: WinScored[] = [];
  const seenThisRun = new Set<string>();
  for (const kw of KEYWORDS) {
    try {
      const res = await searchProducts(kw, { perPage, country: "us" });
      const wins = res.products.map(scoreWin).filter((w) => w.goodsId && !seenThisRun.has(w.goodsId));
      wins.forEach((w) => seenThisRun.add(w.goodsId));
      allWins.push(...wins);
      const fresh = wins.filter((w) => !existing.has(w.goodsId)).length;
      console.log(`  "${kw.slice(0, 40)}" → ${res.products.length} sp, ${wins.length} unique, ${fresh} MỚI`);
    } catch (e: any) {
      console.log(`  ✗ "${kw.slice(0, 40)}" lỗi: ${e?.message ?? e}`);
    }
    await sleep(400);
  }

  const rollup = rollupNiche(allWins);
  const snapshots: ProductSnapshot[] = allWins.map((w) => {
    const opp = scoreOpportunity({ win: w, nicheHeat: rollup.heatScore, demandFit: 50 });
    return {
      goodsId: w.goodsId, nicheKey: NICHE_KEY, nicheGroup: NICHE_GROUP,
      name: w.name, image: w.image, url: w.url ?? "", storeCode: w.storeCode ?? null,
      price: w.price, retailPrice: w.retailPrice, discountPct: w.discountPct,
      finalPrice: opp.finalPrice, commentNum: w.commentNum, rating: w.rating,
      soldNum: null, winScore: w.winScore, winTier: w.winTier,
      marginScore: opp.marginScore, opportunityScore: opp.opportunityScore, source: SOURCE,
    };
  });

  const freshSnaps = snapshots.filter((s) => !existing.has(s.goodsId));
  // chất lượng: rating>=4.5, review>=80 (proven), giá base rẻ
  const quality = freshSnaps.filter((s) => (s.rating ?? 0) >= 4.5 && (s.commentNum ?? 0) >= 80);
  console.log(`\nTổng unique tìm được: ${snapshots.length} | MỚI (chưa có trong pool): ${freshSnaps.length} | đạt chất lượng (⭐≥4.5, ≥80rev): ${quality.length}`);
  console.log("\nTop 20 sp MỚI đạt chất lượng (theo win_score):");
  quality.sort((a, b) => (b.winScore - a.winScore) || ((b.commentNum ?? 0) - (a.commentNum ?? 0)))
    .slice(0, 20)
    .forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. win${s.winScore} ⭐${(s.rating ?? 0).toFixed(2)} ${String(s.commentNum).padStart(4)}rev base$${(s.price ?? 0).toFixed(1)} | ${s.name.slice(0, 50)} | ${s.goodsId}`));

  if (!apply) {
    console.log(`\n(DRY-RUN) thêm --apply để LƯU ${snapshots.length} snapshot (upsert) vào research_product.`);
    return;
  }
  const n = researchStore.saveProducts(day, snapshots);
  console.log(`\n✅ Đã lưu/upsert ${n} snapshot vào research_product (niche oversized-tee, source ${SOURCE}, day ${day}).`);
  console.log(`   Pool mới ~${existing.size + freshSnaps.length} goods_id. Chạy lại rerankDifferentiated để fold vào allocation:`);
  console.log(`   npx tsx src/scripts/rerankDifferentiated.ts "Priority Shop X" 75 --apply`);
};

main().catch((e) => { console.error("💥", e?.message ?? e); process.exit(1); });
