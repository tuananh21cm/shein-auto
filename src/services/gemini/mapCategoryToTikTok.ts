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
        2. **Whole-List Coverage:** The master list spans MANY departments — not just apparel. It includes womenswear, menswear, underwear, shoes, swimwear/beachwear, and sports/outdoor. Map to the closest leaf based on the product's real nature, never restrict yourself to a single department.
        3. **Swimwear & Beachwear:** Bikinis, swimsuits, tankinis, swimdresses, beach cover-ups and similar belong under the "Sports & Outdoor / Swimwear, Surfwear & Wetsuits" branch, NOT under generic tops/bottoms/underwear. For a bikini SET pick "Bikinis Set"; for a standalone bikini top/bottom pick the matching "Bikinis Tops"/"Bikinis Bottoms".
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

    // Parse nằm TRONG retry: response rỗng / non-JSON (do quá tải, bị cắt token,
    // safety block) được coi là retryable thay vì fail luôn.
    return await retryGemini(async () => {
      const result = await model.generateContent(prompt);
      const resp = result.response;
      const finishReason = resp.candidates?.[0]?.finishReason;

      let text = "";
      try {
        text = resp.text() ?? "";
      } catch (e: any) {
        const err: any = new Error(
          `Gemini response.text() failed (finishReason=${finishReason}): ${e?.message}`
        );
        err.retryable = true;
        throw err;
      }

      if (!text.trim()) {
        const err: any = new Error(`Gemini empty response (finishReason=${finishReason})`);
        err.retryable = true;
        throw err;
      }

      try {
        return JSON.parse(text) as CategoryMap;
      } catch {
        const err: any = new Error(
          `Gemini returned non-JSON (finishReason=${finishReason}): ${text.slice(0, 150)}`
        );
        err.retryable = true;
        throw err;
      }
    });
  } catch (error: any) {
    // KHÔNG nuốt lỗi: ném kèm nguyên nhân thật để log/screenshot fatal thấy được lý do.
    console.error("mapCategoryToTikTok failed:", error);
    throw new Error(
      `mapCategoryToTikTok lỗi cho "${thirdPartyInput.slice(0, 80)}...": ${error?.message ?? error}`
    );
  }
}
