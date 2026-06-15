import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { geminiCache } from "./geminiCache";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export async function genTitleFromShein(title: string): Promise<string> {
  if (!title) return "";

  // Cache lookup trước khi gọi Gemini — tiết kiệm token cho listing trùng tên
  const cached = await geminiCache.getTitle(title);
  if (cached) {
    console.log(`💾 [Title Cache] Hit: "${title.slice(0, 60)}..."`);
    return cached;
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
        - Return ONLY the final title string, no explanation.
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
            newTitle: {
              type: SchemaType.STRING,
              description: "The optimized title string only",
            },
          },
          required: ["newTitle"],
        },
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    const data = JSON.parse(result.response.text());
    const newTitle = data.newTitle ?? "";

    if (newTitle) {
      await geminiCache.setTitle(title, newTitle);
    }
    return newTitle;
  } catch (error) {
    console.error("genTitleFromShein failed:", error);
    return "";
  }
}
