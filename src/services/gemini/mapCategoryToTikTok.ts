import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface CategoryMap {
  tiktok_category_path: string;
  confidence_score: number;
  reasoning: string;
}

export async function mapCategoryToTikTok(
  thirdPartyInput: string,
  tiktokMasterList: string[]
): Promise<CategoryMap | null> {
  const systemInstruction = `
        You are an expert E-commerce Catalog Manager for TikTok Shop US.

        **MISSION:**
        Map a messy category/title string from a 3rd-party platform (like SHEIN) to the SINGLE most accurate "Leaf Category" from the provided TikTok Shop Master List.

        **RULES:**
        1. **Leaf Category Only:** You must choose exactly one path from the provided TikTok list.
        2. **Analyze Core Components:** have 2 main category is cloth and shoe.
        3. **Specific Sub-categories:** - If it's has boots in title, it from Shoe category".
        4. **Confidence Score:** - 1.0: Perfect match.
           - 0.5 - 0.9: Close match but requires some inference.
           - < 0.5: Highly uncertain.
    `;

  const prompt = `
        TikTok Master Category List:
        ${tiktokMasterList.join("\n")}

        ---
        Input from 3rd-party: "${thirdPartyInput}"

        Find the best matching category from the list above. Return JSON.
    `;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            tiktok_category_path: {
              type: SchemaType.STRING,
              description: "The full path from the provided Master List",
            },
            confidence_score: { type: SchemaType.NUMBER },
            reasoning: { type: SchemaType.STRING },
          },
          required: ["tiktok_category_path", "confidence_score", "reasoning"],
        },
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    return JSON.parse(result.response.text()) as CategoryMap;
  } catch (error) {
    console.error("mapCategoryToTikTok failed:", error);
    return null;
  }
}
