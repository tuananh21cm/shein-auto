import { callClaudeJSON } from "../anthropic/client";
import { geminiCache } from "./geminiCache";

// Số biến thể tiêu đề gen 1 lần (mỗi shop lấy random 1 cái → tránh trùng tiêu đề).
const VARIANT_COUNT = 6;

const pickRandom = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)] || "";

// Cache có thể là JSON mảng biến thể (mới) hoặc 1 string tiêu đề (cũ) → chuẩn hoá về mảng.
const parseVariants = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim());
  } catch {
    // không phải JSON → tiêu đề đơn bản cũ
  }
  return raw && raw.trim() ? [raw] : [];
};

export async function genTitleFromShein(title: string): Promise<string> {
  if (!title) return "";

  // Cache lookup — lưu MẢNG biến thể theo product_name; mỗi lần gọi trả về 1 biến
  // thể NGẪU NHIÊN → 1 listing đẩy lên nhiều shop sẽ ra tiêu đề khác nhau.
  const cached = await geminiCache.getTitle(title);
  if (cached) {
    const variants = parseVariants(cached);
    if (variants.length) {
      console.log(`💾 [Title Cache] Hit (${variants.length} biến thể): "${title.slice(0, 50)}..."`);
      return pickRandom(variants);
    }
  }

  const systemInstruction = `
        You are a top-performing TikTok Shop US seller specializing in women's fashion (2025-2026).
        MISSION: Optimize the product title for TikTok Shop US search WITHOUT rewriting it from scratch —
        KEEP the main descriptive part of the original title intact and only clean + enrich it.

        RULES:
        - PRESERVE the core product description from the original title: product type and the key
          style / material / feature words, keeping the original wording and order as much as possible.
          Do NOT paraphrase away or drop meaningful descriptors.
        - REMOVE only: brand names, supplier names (SHEIN, ROMWE, INAWLY, etc.), model/SKU codes,
          and pure filler. Never invent features the product does not have.
        - LENGTH MUST BE 11-16 WORDS (~60-110 characters — TikTok Shop 2026 SEO sweet spot; policy max 200 chars).
          Titles with 10 words or fewer are TOO SHORT — always reach at least 11 words:
            • THE FIRST 5-6 WORDS MATTER MOST — mobile search results truncate there. The main buyer
              search keyword (product type + strongest descriptor, e.g. "Ribbed Knit Halter Crop Top")
              MUST appear complete within the first 5-6 words.
            • After the core description, ALWAYS append 3-5 extra SEO keywords TRUE to the product:
              buyer search intent ("2 Piece Set", "Mini Skirt Set"), style/fit/material cues ("Ruched",
              "High Waist", "Stretchy", "Linen"), and trending TikTok US occasion/vibe keywords
              ("Y2K", "Beach Vacation", "Summer Outfit", "Date Night", "Going Out", "Streetwear").
            • If LONGER than 16 words, trim keeping the front-loaded keywords and core description.
            • Example of correct length: "Ribbed Knit Halter Crop Top Slim Fit Stretchy Y2K Streetwear Going Out Summer Top" (15 words).
        - Recommended order: [Main Keyword: type + key feature] → [material/fit/style] → [occasion/vibe].
        - TITLE CASE (TikTok policy): Capitalize the First Letter of Each Word EXCEPT prepositions
          (with, at, by, to, in, for, from, of), conjunctions (and, or), articles (the, a, an).
          NEVER write whole words in ALL CAPS (except legit sizes like "XL" or "2XL").
        - STRICTLY FORBIDDEN in titles (TikTok listing policy — auto-flag risk): promotional/marketing
          claims ("Best Seller", "Hot Sale", "Free Shipping", "% Off", "New Release", "Low Stock",
          "Viral", "TikTok Famous", "Trending", "Guaranteed", "Top Rated"), emojis, special characters
          (#, @, *, !, ~, |), URLs, phone numbers, repeated/stuffed keywords.
        - NO punctuation between keyword segments (use single spaces).
        - If the original title is in German or French, return the title in that language.
        - SPORTS PRODUCT DISGUISE (critical — TikTok Shop requires certifications for sports items):
          • This product must NOT look like sportswear. Convert all sports-related terms to casual/fashion equivalents:
            "Jersey" → "Top" or "Tee", "Football/Soccer Jersey" → "Mesh Top" or "Graphic Tee",
            "Soccer Shirt" / "Football Shirt" → "Graphic Shirt" or "Camisole",
            "Football Kit" → "Outfit Set" or "Matching Set",
            "Soccer Uniform" → "Matching Set", "Football Shorts" → "Athletic Shorts" or "Active Shorts",
            "Training Pants/Shorts" → "Active Pants/Shorts", "Soccer Dress" → "Mesh Dress" or "Casual Dress".
          • Standalone "Football" or "Soccer" (not part of a compound above) → "Sport" or "Graphic".
          • REMOVE: FIFA, UEFA, World Cup → use "Tournament" or "Cup Match",
            Champions League → "Championship", Premier League / La Liga / Bundesliga / Serie A / Ligue 1 → drop entirely,
            Euro Cup / Copa America → "Tournament".
          • REMOVE all club names (Barcelona, Real Madrid, Manchester, Liverpool, Arsenal, Chelsea,
            Bayern, PSG, Juventus, AC Milan, Inter Milan, etc.) and player names (Messi, Ronaldo,
            Neymar, Mbappé, Haaland, Salah, etc.).
          • KEEP country names (Brazil, Argentina, France, Germany, England, etc.) — they are NOT trademarked.
          • For replica jerseys with numbers: keep the number but remove player association.
            E.g. "Messi #10 Argentina Jersey" → "Number 10 Argentina Graphic Tee".
          • The final title should read like a FASHION / CASUAL item, not a sports item.
        - OUTPUT ${VARIANT_COUNT} DISTINCT variants of the title (a JSON array). Every variant must follow
          ALL rules above, but each must DIFFER meaningfully from the others in wording, keyword order, and
          choice of SEO / occasion keywords — so the SAME product listed on multiple shops does NOT get
          identical titles. Do NOT produce trivial reorderings; genuinely vary the SEO/vibe keywords while
          keeping the core product description intact. No explanation.

        OUTPUT JSON SHAPE: {"titles": ["<variant 1>", "<variant 2>", ...]} — exactly ${VARIANT_COUNT} strings.
    `;

  const prompt = `Original Title: ${title}`;

  try {
    const data = await callClaudeJSON<{ titles: string[] }>({
      system: systemInstruction,
      user: prompt,
      maxTokens: 1500,
    });
    const variants: string[] = Array.isArray(data.titles)
      ? data.titles.filter((x: any) => typeof x === "string" && x.trim())
      : [];

    if (variants.length) {
      await geminiCache.setTitle(title, JSON.stringify(variants));
      console.log(`✍️ Gen ${variants.length} biến thể tiêu đề (mỗi shop lấy random 1).`);
      return pickRandom(variants);
    }
    return "";
  } catch (error) {
    console.error("genTitleFromShein failed:", error);
    return "";
  }
}
