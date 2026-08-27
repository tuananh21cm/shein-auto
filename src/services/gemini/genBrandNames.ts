import { callClaudeJSON } from "../anthropic/client";

/**
 * Gen tên BRAND thời trang chuyên nghiệp, ngắn gọn (kiểu ROMWE / SHEIN / ZARA) từ
 * ngách/phong cách user chọn. Trả list tên để user chọn, KHÔNG tự áp.
 */
export interface BrandSuggestion {
  name: string;   // tên brand (viết HOA, ngắn), vd "ROMWE"
  tagline: string; // 1 câu ngắn mô tả vibe (tiếng Anh)
}

const SYSTEM = `You are a senior brand-naming strategist for global fast-fashion e-commerce (think SHEIN, ROMWE, ZARA, MANGO, CIDER, PrettyLittleThing).

Generate brand names that are:
- SHORT: one coined/evocative word, 4-8 letters, occasionally two very short words. Written in UPPERCASE.
- Brandable & pronounceable: invented or evocative words, NOT literal category words. Never use the raw niche word itself (e.g. for "lingerie" do NOT output "LINGERIE").
- Modern, feminine-fashion or streetwear energy matching the given niches/vibe.
- Unique-sounding, memorable, easy to say. Avoid numbers, hyphens, and obvious real trademarks (no SHEIN/ROMWE/ZARA/NIKE etc. themselves).
- Latin letters only, no emoji.

For each name add a 4-8 word English tagline capturing its vibe.
Return STRICT JSON: {"names":[{"name":"...","tagline":"..."}, ...]} with exactly the requested count.`;

export async function genBrandNames(
  niches: string[],
  count = 6
): Promise<BrandSuggestion[]> {
  const vibe = niches.map((n) => n.replace(/-/g, " ").trim()).filter(Boolean).join(", ") || "trendy women's fashion";
  const user = `Niches / vibe: ${vibe}\nGenerate ${count} distinct brand name ideas.`;
  const out = await callClaudeJSON<{ names: BrandSuggestion[] }>({
    system: SYSTEM,
    user,
    maxTokens: 700,
  });
  return (out?.names || [])
    .filter((b) => b && typeof b.name === "string" && b.name.trim())
    .map((b) => ({ name: b.name.trim().toUpperCase().slice(0, 24), tagline: String(b.tagline || "").trim() }))
    .slice(0, count);
}
