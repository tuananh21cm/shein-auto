/**
 * SHEIN search → JSON (cho Hermes skill tiktok-product-research, Chế độ 2 "đào sâu theo mẫu").
 * Tìm SP win tương tự theo keyword qua RapidAPI (KHÔNG cần Kiki), chấm winScore, in JSON sạch.
 *
 * Usage: npx tsx src/scripts/sheinSearchJson.ts "<keyword>" [limit]
 * Output: { ok, keyword, total, source, count, winners: [...] }
 */
import "dotenv/config";
import { searchProducts } from "../services/shein/client";
import { rankByWin } from "../core/winScore";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = async () => {
  const argv = process.argv.slice(2);
  const limit = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 10;
  const kw = argv.join(" ").trim();
  if (!kw) return out({ ok: false, error: 'Thiếu keyword. Dùng: npx tsx src/scripts/sheinSearchJson.ts "lace bodysuit"' });

  const res = await searchProducts(kw, { perPage: 40 });
  const ranked = rankByWin(res.products).slice(0, limit);

  const winners = ranked.map((p) => ({
    name: p.name,
    goodsId: p.goodsId,
    winScore: p.winScore,
    winTier: p.winTier,
    commentNum: p.commentNum,   // review ~ proxy lượng bán
    rating: p.rating,
    price: p.price,             // giá bán SHEIN hiện tại (USD) — vốn dropship
    retailPrice: p.retailPrice,
    discountPct: p.discountPct,
    url: (p.url || "").split("?")[0],
    image: p.image || "",        // URL ảnh sản phẩm (cho report dạng ảnh)
  }));

  out({ ok: true, keyword: kw, total: res.total, source: res.source, count: winners.length, winners });
};

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }));
