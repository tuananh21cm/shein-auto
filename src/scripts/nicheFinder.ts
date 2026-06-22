/**
 * nicheFinder — Phase 1 skill "shein-niche-finder".
 * Quét kalodata_category → lọc fashion → chấm NicheScore (Cầu × Gap × Cung × Biên) → top ngách ngon.
 *
 * NicheScore = Demand*0.35 + Gap*0.30 + Supply*0.25 + Margin*0.10
 *   Demand : growth_rate + trend_slope + revenue (cầu TikTok đang lên)
 *   Gap    : 1 - top3_ratio (+ shop_number) — top3 càng ít thâu tóm = càng nhiều cửa cho người mới
 *   Supply : win density SHEIN (research_product khớp ngách) — có hàng win để dropship
 *   Margin : % sp lọt sweet-spot vốn $7-15
 * Cổng loại: top3_ratio > 0.90 (sân độc quyền) · chỉ fashion nữ.
 *
 * Usage: npx tsx src/scripts/nicheFinder.ts [limit]
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { isFashionCategory } from "../core/research/fashionFilter";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const out = (o: any) => console.log(JSON.stringify(o, null, 1));
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Từ khoá để map tên category Kalodata → search trong research_product (specific → general).
const SUPPLY_TERMS = [
  "bodysuit", "shapewear", "lingerie", "corset", "bustier", "bikini", "swimsuit", "swimwear",
  "lounge", "romper", "jumpsuit", "cami", "camisole", "bra", "panty", "thong", "sleep",
  "maxi dress", "bodycon", "dress", "skirt", "blouse", "crop top", "tank top", "top",
  "cargo", "wide leg", "jean", "denim", "shorts", "pants", "legging", "two piece", "set",
  "hoodie", "sweater", "cardigan", "jacket", "coat",
];
function supplyTerm(name: string): string | null {
  const n = (name || "").toLowerCase();
  for (const t of SUPPLY_TERMS) if (n.includes(t)) return t;
  return null;
}

const main = () => {
  const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;
  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
  const day = (db.prepare("SELECT MAX(day) d FROM kalodata_category").get() as any)?.d;
  if (!day) return out({ ok: false, error: "Chưa có data kalodata_category" });

  const cats = db.prepare(
    `SELECT name, revenue, growth_rate, shop_number, top3_ratio, trend_slope
     FROM kalodata_category WHERE day=? AND revenue>0`
  ).all(day) as any[];

  const prodStmt = db.prepare(
    `SELECT price, win_score FROM research_product WHERE name LIKE '%'||?||'%' AND price IS NOT NULL`
  );

  const scored = cats
    .filter((c) => isFashionCategory(c.name) && (c.top3_ratio == null || c.top3_ratio <= 0.9))
    .map((c) => {
      // ── Demand ──
      const growthScore = clamp((c.growth_rate ?? 0) * 50);              // 200%+ growth = 100
      const slopeScore = clamp(((c.trend_slope ?? 0) + 0.5) * 60);       // slope >0 = đang lên
      const revScore = clamp((Math.log10((c.revenue ?? 0) + 1) / 9) * 100); // ~1 tỷ = 100
      const demand = Math.round(growthScore * 0.5 + slopeScore * 0.2 + revScore * 0.3);

      // ── Gap (cửa cho người mới) ──
      const t3 = c.top3_ratio ?? 0.5;
      const gap = Math.round(clamp((1 - t3) * 100) * 0.75 + clamp((c.shop_number ?? 0) * 1.5) * 0.25);

      // ── Supply + Margin (khớp SHEIN) ──
      const term = supplyTerm(c.name);
      let supply = 50, margin = 50, matched = 0, medCost: number | null = null;
      if (term) {
        const ps = prodStmt.all(term) as any[];
        matched = ps.length;
        if (matched > 0) {
          const wins = ps.filter((p) => (p.win_score ?? 0) >= 70).length;
          supply = Math.round(clamp((wins / matched) * 100 * 0.7 + clamp(matched * 4) * 0.3));
          const sweet = ps.filter((p) => p.price >= 7 && p.price <= 15).length;
          margin = Math.round(clamp((sweet / matched) * 100));
          medCost = median(ps.map((p) => p.price));
        }
      }

      const nicheScore = Math.round(demand * 0.35 + gap * 0.3 + supply * 0.25 + margin * 0.1);
      const growthPct = Math.round((c.growth_rate ?? 0) * 100);
      const top3Pct = Math.round((c.top3_ratio ?? 0) * 100);
      const verdict =
        top3Pct > 90 || matched < 5 ? "TRÁNH"
        : nicheScore >= 65 ? "NÊN test"
        : nicheScore >= 50 ? "CÂN NHẮC" : "YẾU";
      const reason =
        `growth ${growthPct}% · top3 chiếm ${top3Pct}% (${top3Pct < 60 ? "còn cửa" : "khá chặt"}) · ` +
        `${c.shop_number} shop · ` +
        (matched ? `SHEIN ${matched} sp khớp, vốn ~$${medCost?.toFixed(1)}` : "SHEIN: chưa rõ cung");

      return {
        name: c.name, nicheScore, verdict, demand, gap, supply, margin,
        growthPct, top3Pct, shopNumber: c.shop_number,
        revenue: Math.round(c.revenue), supplyMatched: matched, medianCost: medCost,
        reason,
      };
    })
    .sort((a, b) => b.nicheScore - a.nicheScore)
    .slice(0, limit);

  db.close();
  out({ ok: true, day, count: scored.length, niches: scored });
};

main();
