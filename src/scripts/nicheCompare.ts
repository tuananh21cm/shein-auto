/**
 * nicheCompare — Chế độ C của skill "shein-niche-finder": SO SÁNH 2-4 ngách.
 * Chấm từng ngách (3 trụ) → xếp hạng → khuyến nghị nên đánh ngách nào trước + phân bổ đa shop.
 *
 * Usage: npx tsx src/scripts/nicheCompare.ts "shapewear" "bikini" "corset top"
 * Output JSON: { ok, day, ranked:[{niche,nicheScore,demand,gap,supply,margin,verdict,...}], recommendation }
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

function analyzeNiche(db: any, day: string, niche: string) {
  const cat = db.prepare(
    `SELECT name, revenue, growth_rate, shop_number, top3_ratio, trend_slope
     FROM kalodata_category WHERE day=? AND name LIKE '%'||?||'%' ORDER BY revenue DESC LIMIT 1`
  ).get(day, niche) as any;

  let demand = 0, gap = 0, top3Pct: number | null = null, growthPct: number | null = null, matchedCategory: string | null = null;
  if (cat) {
    demand = Math.round(
      clamp((cat.growth_rate ?? 0) * 50) * 0.5 +
      clamp(((cat.trend_slope ?? 0) + 0.5) * 60) * 0.2 +
      clamp((Math.log10((cat.revenue ?? 0) + 1) / 9) * 100) * 0.3
    );
    gap = Math.round(clamp((1 - (cat.top3_ratio ?? 0.5)) * 100) * 0.75 + clamp((cat.shop_number ?? 0) * 1.5) * 0.25);
    top3Pct = Math.round((cat.top3_ratio ?? 0) * 100);
    growthPct = Math.round((cat.growth_rate ?? 0) * 100);
    matchedCategory = cat.name;
  }

  const ps = db.prepare(
    `SELECT price, win_score FROM research_product WHERE name LIKE '%'||?||'%' AND price IS NOT NULL`
  ).all(niche) as any[];
  const matched = ps.length;
  const wins = ps.filter((p) => (p.win_score ?? 0) >= 70).length;
  const sweet = ps.filter((p) => p.price >= 7 && p.price <= 15).length;
  const supply = matched ? Math.round(clamp((wins / matched) * 100 * 0.7 + clamp(matched * 4) * 0.3)) : 0;
  const margin = matched ? Math.round(clamp((sweet / matched) * 100)) : 0;
  const medCost = median(ps.map((p) => p.price));

  const nicheScore = Math.round((demand || 50) * 0.35 + (gap || 50) * 0.3 + supply * 0.25 + margin * 0.1);
  let verdict: string;
  if (top3Pct != null && top3Pct > 90) verdict = "TRÁNH — sân độc quyền";
  else if (matched < 5) verdict = "TRÁNH — SHEIN thiếu hàng win";
  else if (nicheScore >= 65) verdict = "NÊN test";
  else if (nicheScore >= 50) verdict = "CÂN NHẮC";
  else verdict = "YẾU";

  return {
    niche, nicheScore, demand: demand || null, gap: gap || null, supply, margin,
    growthPct, top3Pct, matched, winProducts: wins, medianCost: medCost, matchedCategory, verdict,
  };
}

const main = () => {
  const niches = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
  if (niches.length < 2) return out({ ok: false, error: 'Cần ≥2 ngách. Dùng: npx tsx src/scripts/nicheCompare.ts "shapewear" "bikini"' });

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
  const day = (db.prepare("SELECT MAX(day) d FROM kalodata_category").get() as any)?.d;

  const ranked = niches.map((n) => analyzeNiche(db, day, n)).sort((a, b) => b.nicheScore - a.nicheScore);
  db.close();

  const ok = ranked.filter((r) => !r.verdict.startsWith("TRÁNH"));
  const recommendation = {
    best: ranked[0]?.niche ?? null,
    order: ranked.map((r) => `${r.niche} (${r.nicheScore})`),
    note:
      ok.length === 0
        ? "Cả mấy ngách đều có vấn đề (xem verdict) — nên tìm ngách khác."
        : `Ưu tiên đánh "${ranked[0].niche}" trước (điểm cao nhất). ` +
          (ok.length >= 2
            ? `Có thể giao "${ok[1].niche}" cho shop khác để tránh 10 shop trùng hàng.`
            : "Các ngách còn lại yếu hơn, để sau."),
  };

  out({ ok: true, day, ranked, recommendation });
};

main();
