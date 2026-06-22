/**
 * nicheDeepDive — Chế độ B của skill "shein-niche-finder": soi sâu 1 NGÁCH.
 * Phân tích đủ 3 trụ (Cầu/Gap/Cung+Biên) cho 1 ngách sếp chỉ định + list sp win SHEIN + verdict.
 *
 * Usage: npx tsx src/scripts/nicheDeepDive.ts "<niche>"   (vd "shapewear", "bikini", "corset top")
 * Output JSON: { ok, niche, day, kalodata, supply, scores, verdict, warnings, topProducts }
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const out = (o: any) => console.log(JSON.stringify(o, null, 1));
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const main = () => {
  const niche = process.argv.slice(2).join(" ").trim();
  if (!niche) return out({ ok: false, error: 'Thiếu ngách. Dùng: npx tsx src/scripts/nicheDeepDive.ts "shapewear"' });

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
  const day = (db.prepare("SELECT MAX(day) d FROM kalodata_category").get() as any)?.d;

  // ── Trụ CẦU + GAP: category Kalodata khớp gần nhất (theo revenue) ──
  const cat = db.prepare(
    `SELECT name, revenue, growth_rate, shop_number, top3_ratio, top10_ratio, trend_slope
     FROM kalodata_category WHERE day=? AND name LIKE '%'||?||'%' ORDER BY revenue DESC LIMIT 1`
  ).get(day, niche) as any;

  let demand = 0, gap = 0;
  let kalodata: any = null;
  if (cat) {
    const growthScore = clamp((cat.growth_rate ?? 0) * 50);
    const slopeScore = clamp(((cat.trend_slope ?? 0) + 0.5) * 60);
    const revScore = clamp((Math.log10((cat.revenue ?? 0) + 1) / 9) * 100);
    demand = Math.round(growthScore * 0.5 + slopeScore * 0.2 + revScore * 0.3);
    const t3 = cat.top3_ratio ?? 0.5;
    gap = Math.round(clamp((1 - t3) * 100) * 0.75 + clamp((cat.shop_number ?? 0) * 1.5) * 0.25);
    kalodata = {
      matchedCategory: cat.name,
      revenue: Math.round(cat.revenue), growthPct: Math.round((cat.growth_rate ?? 0) * 100),
      shopNumber: cat.shop_number, top3Pct: Math.round((cat.top3_ratio ?? 0) * 100),
      top10Pct: Math.round((cat.top10_ratio ?? 0) * 100), trendSlope: cat.trend_slope,
    };
  }

  // ── Trụ CUNG + BIÊN: research_product khớp ngách ──
  const ps = db.prepare(
    `SELECT name, price, rating, comment_num, win_score, url, image
     FROM research_product WHERE name LIKE '%'||?||'%' AND price IS NOT NULL
     ORDER BY win_score DESC, opportunity_score DESC`
  ).all(niche) as any[];
  const matched = ps.length;
  const wins = ps.filter((p) => (p.win_score ?? 0) >= 70).length;
  const sweet = ps.filter((p) => p.price >= 7 && p.price <= 15).length;
  const supply = matched ? Math.round(clamp((wins / matched) * 100 * 0.7 + clamp(matched * 4) * 0.3)) : 0;
  const margin = matched ? Math.round(clamp((sweet / matched) * 100)) : 0;
  const medCost = median(ps.map((p) => p.price));

  const topProducts = ps.slice(0, 8).map((p) => ({
    name: (p.name || "").slice(0, 55), win: p.win_score, price: p.price,
    rating: p.rating, review: p.comment_num, url: (p.url || "").split("?")[0],
  }));

  // ── NicheScore + Verdict ──
  const nicheScore = Math.round((demand || 50) * 0.35 + (gap || 50) * 0.3 + supply * 0.25 + margin * 0.1);
  const warnings: string[] = [];
  if (!cat) warnings.push("Kalodata không có category khớp trực tiếp → Cầu/Gap dùng giá trị trung tính; tin cậy chủ yếu ở Cung SHEIN.");
  if (kalodata && kalodata.top3Pct > 90) warnings.push(`⛔ top3 chiếm ${kalodata.top3Pct}% — sân gần như độc quyền, người mới rất khó chen.`);
  if (matched < 10) warnings.push(`SHEIN chỉ ${matched} sp khớp — nguồn hàng mỏng, khó đa dạng listing.`);
  if (medCost != null && medCost > 15) warnings.push(`Vốn trung vị ~$${medCost.toFixed(1)} > $15 — biên dropship sẽ mỏng.`);

  let verdict: string;
  if (kalodata && kalodata.top3Pct > 90) verdict = "TRÁNH — sân độc quyền";
  else if (matched < 5) verdict = "TRÁNH — SHEIN gần như không có hàng win";
  else if (nicheScore >= 65) verdict = "NÊN test";
  else if (nicheScore >= 50) verdict = "CÂN NHẮC";
  else verdict = "YẾU — cân nhắc kỹ";

  db.close();
  out({
    ok: true, niche, day,
    scores: { nicheScore, demand: demand || null, gap: gap || null, supply, margin },
    kalodata,
    supply: { matched, winProducts: wins, sweetSpot: sweet, medianCost: medCost },
    verdict, warnings, topProducts,
  });
};

main();
