/**
 * expandNicheKeywords — sinh bộ TỪ KHÓA TÌM KIẾM SHEIN tương tự/mở rộng 1 ngách bằng Gemini.
 * Cache theo (nicheKey|query) để khỏi gọi lại. Luôn kèm query gốc. Fallback [query] nếu lỗi.
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { config } from "../../config";
import { geminiCache } from "./geminiCache";
import { retryGemini } from "../../utils/retryGemini";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export async function expandNicheKeywords(nicheKey: string, baseQuery: string, count = 8): Promise<string[]> {
  const query = (baseQuery || nicheKey.replace(/-/g, " ")).trim();
  const cacheKey = `${nicheKey}|${query}|${count}`;
  const cached = await geminiCache.getKeywords(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* re-gen */ } }

  const systemInstruction = `Bạn là chuyên gia SEO SHEIN & TikTok Shop US (thời trang NGƯỜI LỚN nữ 2026).
Cho 1 NGÁCH, sinh ${count} TỪ KHÓA TÌM KIẾM để search trên SHEIN — mở rộng/đa dạng theo style, feature, occasion NHƯNG CÙNG loại sản phẩm với ngách (không lệch sang loại khác).
CHỈ thời trang NGƯỜI LỚN (women). TUYỆT ĐỐI KHÔNG keyword hàng trẻ em (kids/girls/boys/toddler/baby/children/youth). Thêm "women" khi cần để tránh ra hàng trẻ em.
Mỗi keyword 2-4 từ tiếng Anh, là cụm người mua US thật sự search. KHÔNG brand, KHÔNG mã sản phẩm.
Trả JSON {"keywords": string[]}.`;
  const prompt = `Ngách: ${nicheKey}\nQuery gốc: "${query}"`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: { keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } } },
          required: ["keywords"],
        },
      },
    });
    const r = await retryGemini(() => model.generateContent(prompt));
    const obj = JSON.parse(r.response.text());
    const gen: string[] = Array.isArray(obj.keywords) ? obj.keywords.map((s: any) => String(s).trim()).filter(Boolean) : [];
    const kws = [...new Set([query, ...gen])].slice(0, count + 1);
    await geminiCache.setKeywords(cacheKey, JSON.stringify(kws));
    return kws;
  } catch {
    return [query];
  }
}
