import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { geminiCache } from "./geminiCache";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

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
        - LENGTH MUST BE 90-150 characters:
            • If after cleanup it is SHORTER than 90 chars, EXTEND it by appending SEO keywords that
              match the product's actual content — buyer search intent ("2 Piece Set", "Mini Skirt Set"),
              style/fit/material cues ("Ruched", "Ruffle", "High Waist", "Stretchy", "Linen"), and
              trending TikTok US occasion/vibe keywords ("Y2K", "Beach Vacation", "Summer Outfit",
              "Date Night", "Going Out", "Streetwear"). Only add keywords TRUE to the product.
            • If already within 90-150 chars, keep it essentially as-is after cleanup.
            • If LONGER than 150 chars, trim to <=150, keeping the front-loaded keywords and core description.
        - Front-load the strongest buyer search keyword near the start.
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
          keeping the core product description intact. No explanation, array of strings only.
    `;

  const prompt = `Original Title: ${title}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            titles: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: `${VARIANT_COUNT} distinct optimized title variants`,
            },
          },
          required: ["titles"],
        },
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    const data = JSON.parse(result.response.text());
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
