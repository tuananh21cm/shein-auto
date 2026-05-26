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
        MISSION: Rewrite the product title to maximize TikTok Shop US search ranking and click-through rate.

        RULES:
        - NO brand names, NO supplier names (SHEIN, INAWLY, etc.), NO model codes.
        - Lead with the strongest buyer search intent keyword (e.g. "2 Piece Set", "Mini Skirt Set", "Crop Top Set").
        - Include trending TikTok US lifestyle keywords relevant to the product (e.g. "Y2K", "Beach Vacation", "Summer Outfit", "Going Out", "Date Night", "Streetwear").
        - Include material/fit cues buyers search: "Ruched", "Ruffle", "High Waist", "Stretchy", "Linen", etc.
        - Format: [Search Intent Keyword] + [Style Feature] + [Occasion/Vibe] — NO punctuation between segments.
        - Length: 60-100 characters (TikTok title limit is 255 but algo favors front-loaded keywords under 100).
        - Sentence case only (capitalize first word and proper nouns only).
        - If original title is in German or French, return title in that language.
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
