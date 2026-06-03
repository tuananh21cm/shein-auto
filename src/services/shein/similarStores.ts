/**
 * Tìm shop SHEIN tương tự / đối thủ cùng ngách.
 *
 * Cơ chế (vì SHEIN không có endpoint "similar stores", và list sp theo store
 * đang hỏng): lấy các ngách top của store input → search từng ngách → gom các
 * store_code cùng xuất hiện → xếp hạng theo độ trùng ngách + tần suất + winScore.
 * Đây thực chất là bản đồ ĐỐI THỦ của store trong các ngách nó đang bán.
 */
import { searchProducts, getStoreKeywords, getStoreQuantity } from "./client";
import { rankByWin } from "../../core/winScore";

export interface SimilarStore {
  storeCode: string;
  /** Số ngách (trên tổng keyword đã quét) mà store này cùng xuất hiện */
  nicheOverlap: number;
  niches: string[];
  /** Số sp của store này lọt vào kết quả search */
  productsSeen: number;
  avgWin: number;
  similarity: number; // 0-100
  sample: { name: string; image: string; goodsId: string } | null;
  catalogSize?: number | null;
  storeUrl?: string | null;
}

export interface SimilarStoresResult {
  input: { storeCode: string; keywords: string[]; catalogSize: number | null; storeUrl: string | null };
  totalCandidates: number;
  stores: SimilarStore[];
}

export async function findSimilarStores(
  storeCode: string,
  opts: { country?: string; maxKeywords?: number; perPage?: number; enrichTop?: number } = {}
): Promise<SimilarStoresResult> {
  const country = opts.country ?? "us";
  const maxKeywords = opts.maxKeywords ?? 5;
  const perPage = opts.perPage ?? 40;
  const enrichTop = opts.enrichTop ?? 8;

  const allKeywords = await getStoreKeywords(storeCode, country);
  const keywords = allKeywords.slice(0, maxKeywords);
  if (!keywords.length) {
    throw new Error("Store không có keyword/ngách (storeCode sai hoặc store rỗng)");
  }

  type Agg = {
    storeCode: string;
    productCount: number;
    niches: Set<string>;
    winSum: number;
    sample: { name: string; image: string; goodsId: string } | null;
  };
  const map = new Map<string, Agg>();

  let searchFails = 0;
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    let products;
    try {
      const res = await searchProducts(kw, { perPage, country });
      products = rankByWin(res.products);
    } catch (e: any) {
      searchFails++;
      // Fail-fast: nếu search đầu tiên đã lỗi → provider đang chết, báo ngay
      if (i === 0) {
        throw new Error(
          `SHEIN search đang lỗi (provider degraded): ${e?.message ?? "timeout"}. Thử lại sau vài phút.`
        );
      }
      continue; // các keyword sau lỗi lẻ tẻ thì bỏ qua
    }
    for (const p of products) {
      if (!p.storeCode || p.storeCode === storeCode) continue;
      let e = map.get(p.storeCode);
      if (!e) {
        e = { storeCode: p.storeCode, productCount: 0, niches: new Set(), winSum: 0, sample: null };
        map.set(p.storeCode, e);
      }
      e.productCount++;
      e.niches.add(kw);
      e.winSum += p.winScore;
      if (!e.sample && p.image) e.sample = { name: p.name, image: p.image, goodsId: p.goodsId };
    }
  }

  let stores: SimilarStore[] = [...map.values()].map((e) => {
    const nicheOverlap = e.niches.size;
    const avgWin = e.productCount ? Math.round(e.winSum / e.productCount) : 0;
    // similarity: trùng ngách quan trọng nhất, rồi tần suất, rồi chất lượng win
    const overlapScore = (nicheOverlap / keywords.length) * 100;
    const freqScore = Math.min(100, e.productCount * 8);
    const similarity = Math.round(overlapScore * 0.6 + freqScore * 0.25 + avgWin * 0.15);
    return {
      storeCode: e.storeCode,
      nicheOverlap,
      niches: [...e.niches],
      productsSeen: e.productCount,
      avgWin,
      similarity,
      sample: e.sample,
    };
  });

  stores.sort(
    (a, b) =>
      b.nicheOverlap - a.nicheOverlap ||
      b.productsSeen - a.productsSeen ||
      b.avgWin - a.avgWin
  );

  const totalCandidates = stores.length;
  const top = stores.slice(0, enrichTop);

  // Enrich top store: quy mô catalog + URL
  for (const s of top) {
    try {
      const q = await getStoreQuantity(s.storeCode, country);
      s.catalogSize = q.quantity;
      s.storeUrl = q.storeUrl;
    } catch {
      /* ignore */
    }
  }

  // Thông tin store input
  let inputInfo = { quantity: null as number | null, storeUrl: null as string | null };
  try {
    inputInfo = await getStoreQuantity(storeCode, country);
  } catch {
    /* ignore */
  }

  return {
    input: { storeCode, keywords, catalogSize: inputInfo.quantity, storeUrl: inputInfo.storeUrl },
    totalCandidates,
    stores: top,
  };
}
