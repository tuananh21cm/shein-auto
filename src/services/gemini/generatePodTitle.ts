import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { geminiCache } from "./geminiCache";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Title cho áo POD: GIỮ NGUYÊN key chính (tên file thiết kế) làm đầu title, rồi để AI
 * mix thêm các key T-shirt bán chạy (graphic tee, unisex shirt, gift, vintage...).
 * Khác genTitleFromShein (viết lại toàn bộ) — ở đây cụm gốc PHẢI còn nguyên vẹn.
 */
export async function generatePodTitle(coreKey: string): Promise<string> {
  const core = (coreKey || "").trim();
  if (!core) return "";

  const cacheKey = `POD::${core}`;
  const cached = await geminiCache.getTitle(cacheKey);
  if (cached) {
    console.log(`💾 [POD Title Cache] Hit: "${core}"`);
    return cached;
  }

  const systemInstruction = `
    You are a top TikTok Shop US seller of print-on-demand graphic T-shirts (2025-2026).
    MISSION: Build a high-CTR, search-optimized T-shirt title.

    HARD RULES:
    - KEEP the user's DESIGN PHRASE EXACTLY as given, word-for-word, and put it at the FRONT of the title. Do NOT rephrase, translate, shorten, or fix its spelling/casing.
    - After the design phrase, append T-shirt search keywords buyers actually use: pick from "Graphic Tee", "Unisex T-Shirt", "Funny Shirt", "Vintage Tee", "Trendy Shirt", "Gift for Him/Her", "Aesthetic Tee", "Cotton Tee", "Oversized Shirt" — choose only the ones that fit the design's theme.
    - NO brand names, NO supplier names, NO model codes.
    - NO punctuation between segments (just spaces).
    - Total length 60-100 characters.
    - Return ONLY the final title string.
  `;

  const prompt = `DESIGN PHRASE (keep verbatim, lead with it): ${core}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: { newTitle: { type: SchemaType.STRING, description: "Final title string only" } },
          required: ["newTitle"],
        },
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    let newTitle = (JSON.parse(result.response.text()).newTitle ?? "").trim();

    // Bảo hiểm: nếu AI lỡ bỏ cụm gốc → ép prepend để key chính luôn còn nguyên.
    if (newTitle && !newTitle.toLowerCase().includes(core.toLowerCase())) {
      newTitle = `${core} ${newTitle}`.trim();
    }
    if (!newTitle) newTitle = `${core} Graphic Tee Unisex T-Shirt`;

    await geminiCache.setTitle(cacheKey, newTitle);
    return newTitle;
  } catch (error) {
    console.error("generatePodTitle failed:", error);
    // Fallback an toàn: giữ key gốc + vài key tee cơ bản.
    return `${core} Graphic Tee Unisex T-Shirt`;
  }
}
