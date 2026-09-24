/**
 * shopSourcing — 3 bước AI cho việc tìm hàng SHEIN cho 1 shop theo ngách (dùng callClaudeJSON):
 *   1. inferNiche(titles)        — đọc title sp shop đang bán → đoán NGÁCH.
 *   2. generateKeywords(niche)   — sinh keyword search SHEIN hợp ngách (port prompt cũ expandKeywords).
 *   3. scoreListingsForShop(...)  — chấm từng candidate: hợp ngách tới đâu + có đáng bán không.
 * Tất cả trả JSON. Model mặc định = LISTING_MODEL (Haiku 4.5, rẻ) — đổi qua param.
 */
import { callClaudeJSON } from "./client";

export interface ScoredListing {
  goodsId: string;
  fit: number;   // 0-100 hợp ngách
  keep: boolean; // AI khuyên lấy hay không
  reason: string;
}

/** Đoán ngách shop từ title các sp đang bán. Trả 1 câu ngách ngắn (gồm loại sp + style). */
export async function inferNiche(titles: string[], model?: string): Promise<string> {
  const sample = titles.map((t) => (t || "").trim()).filter(Boolean).slice(0, 60);
  if (!sample.length) throw new Error("Shop chưa có listing để đoán ngách");
  const data = await callClaudeJSON<{ niche: string }>({
    model,
    maxTokens: 300,
    system:
      "Bạn là chuyên gia chọn hàng (product sourcing) TikTok Shop US, thời trang nữ 2026. " +
      "Cho DANH SÁCH TÊN sản phẩm 1 shop đang bán, hãy suy ra NGÁCH chính của shop: " +
      "1 câu NGẮN (tiếng Việt) nêu rõ LOẠI sản phẩm + phong cách/đối tượng (vd \"váy nữ dự tiệc phong cách y2k\", " +
      "\"đồ định hình (shapewear) nữ\"). Chỉ 1 ngách bao trùm nhất, không liệt kê nhiều. Trả JSON {\"niche\": string}.",
    user: "Tên sản phẩm shop đang bán:\n" + sample.map((t, i) => `${i + 1}. ${t}`).join("\n"),
  });
  return String(data.niche || "").trim();
}

/** Sinh `count` keyword search SHEIN hợp ngách (luôn kèm lock keywords truyền vào, dedup). */
export async function generateKeywords(niche: string, count = 8, lock: string[] = [], model?: string): Promise<string[]> {
  const data = await callClaudeJSON<{ keywords: string[] }>({
    model,
    maxTokens: 500,
    system:
      "Bạn là chuyên gia SEO SHEIN & TikTok Shop US (thời trang NGƯỜI LỚN nữ 2026). " +
      `Cho 1 NGÁCH, sinh ${count} TỪ KHÓA TÌM KIẾM để search trên SHEIN — mở rộng/đa dạng theo style, ` +
      "feature, occasion NHƯNG CÙNG loại sản phẩm với ngách (không lệch sang loại khác). " +
      "CHỈ thời trang NGƯỜI LỚN (women). TUYỆT ĐỐI KHÔNG keyword hàng trẻ em " +
      "(kids/girls/boys/toddler/baby/children/youth); thêm \"women\" khi cần để tránh ra hàng trẻ em. " +
      "Mỗi keyword 2-4 từ tiếng Anh, là cụm người mua US thật sự search. KHÔNG brand, KHÔNG mã sản phẩm. " +
      "Trả JSON {\"keywords\": string[]}.",
    user: `Ngách: ${niche}`,
  });
  const gen = (data.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  return [...new Set([...lock.map((k) => k.trim()).filter(Boolean), ...gen])].slice(0, count + lock.length);
}

/** Chấm từng candidate hợp ngách + đáng bán. Gửi gọn (id/name/price/review/rating/cat) → JSON. */
export async function scoreListingsForShop(
  niche: string,
  items: { goodsId: string; name?: string; price: number | null; reviewCount: number; rating: number | null; catName?: string }[],
  model?: string
): Promise<ScoredListing[]> {
  if (!items.length) return [];
  const compact = items.map((p) => ({
    id: p.goodsId,
    name: (p.name || "").slice(0, 90),
    price: p.price,
    rev: p.reviewCount,
    rate: p.rating,
    cat: (p.catName || "").slice(0, 40),
  }));
  const data = await callClaudeJSON<{ results: ScoredListing[] }>({
    model,
    maxTokens: 8000,
    system:
      "Bạn là chuyên gia chọn hàng (product sourcing) TikTok Shop US, thời trang nữ 2026. " +
      "Cho NGÁCH của shop và DANH SÁCH sản phẩm SHEIN (kèm review=proxy lượng bán, rating, giá), " +
      "hãy chấm MỖI sp: `fit` 0-100 = hợp ngách tới đâu (loại sp/style đúng ngách), `keep` = có nên lấy về shop không " +
      "(hợp ngách VÀ đáng bán: review nhiều + rating cao + giá hợp lý), `reason` = lý do NGẮN (tiếng Việt, ≤12 từ). " +
      "Loại thẳng (keep=false) hàng KHÔNG đúng ngách, hàng trẻ em, review quá thấp. " +
      "Trả JSON {\"results\":[{\"id\":string,\"fit\":number,\"keep\":boolean,\"reason\":string}]} — đủ MỌI id nhận vào.",
    user: `Ngách shop: ${niche}\n\nSản phẩm:\n${JSON.stringify(compact)}`,
  });
  return (data.results || []).map((r) => ({
    goodsId: String(r.goodsId ?? (r as any).id ?? ""),
    fit: Number(r.fit) || 0,
    keep: !!r.keep,
    reason: String(r.reason || "").slice(0, 80),
  })).filter((r) => r.goodsId);
}
