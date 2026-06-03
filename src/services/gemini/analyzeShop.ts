import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { geminiCache } from "./geminiCache";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/** Số liệu tổng hợp của shop, đưa cho AI phân tích (không gửi từng listing). */
export interface ShopAnalysisInput {
  shopName: string;
  site: string;
  total: number;
  scores: {
    overall: number;
    grade: string;
    title: number;
    image: number;
    niche: number;
    price: number;
    stock: number;
  };
  issueSummary: {
    titleShortPct: number;
    titleLongPct: number;
    fewImagesPct: number;
    noPricePct: number;
    outOfStockPct: number;
    hasErrorPct: number;
  };
  niche: {
    categoryCount: number;
    topShare: number;
    top3Share: number;
    chaotic: boolean;
    topCategories: { name: string; nodePath: string; count: number; percent: number }[];
  };
  priceStats: { min: number | null; max: number | null; avg: number | null; currency: string };
}

export interface ShopAnalysisResult {
  uu_diem: string[];
  nhuoc_diem: string[];
  can_toi_uu: string[];
  goi_y_san_pham: string[];
  goi_y_ngach: string[];
  tom_tat: string;
}

const buildPrompt = (input: ShopAnalysisInput): string => {
  const topCats = input.niche.topCategories
    .map((c, i) => `  ${i + 1}. ${c.name} (${c.nodePath || "?"}) — ${c.count} sp (${c.percent}%)`)
    .join("\n");
  const cur = input.priceStats.currency || "";
  return `
PHÂN TÍCH SHOP TIKTOK SHOP (bán qua 4Seller)

Tên shop: ${input.shopName}
Thị trường: ${input.site}
Tổng listing active: ${input.total}

ĐIỂM TỔNG: ${input.scores.overall}/100 (hạng ${input.scores.grade})
  - Title:  ${input.scores.title}/100
  - Ảnh:    ${input.scores.image}/100
  - Ngách:  ${input.scores.niche}/100
  - Giá:    ${input.scores.price}/100
  - Tồn kho:${input.scores.stock}/100

TỶ LỆ VẤN ĐỀ:
  - Title quá ngắn: ${input.issueSummary.titleShortPct}%
  - Title quá dài:  ${input.issueSummary.titleLongPct}%
  - Thiếu ảnh (<4): ${input.issueSummary.fewImagesPct}%
  - Không có giá:   ${input.issueSummary.noPricePct}%
  - Hết hàng:       ${input.issueSummary.outOfStockPct}%
  - Listing lỗi:    ${input.issueSummary.hasErrorPct}%

PHÂN BỐ NGÁCH:
  - Số category khác nhau: ${input.niche.categoryCount}
  - Top 1 chiếm: ${input.niche.topShare}% · Top 3 chiếm: ${input.niche.top3Share}%
  - Đánh giá loạn ngách: ${input.niche.chaotic ? "CÓ (phân tán)" : "Không (tập trung)"}
  Top categories:
${topCats}

GIÁ: ${cur}${input.priceStats.min ?? "?"} – ${cur}${input.priceStats.max ?? "?"} (TB ${cur}${input.priceStats.avg ?? "?"})

Hãy phân tích sức khỏe shop và trả về JSON.
`.trim();
};

const SYSTEM_INSTRUCTION = `
Bạn là chuyên gia vận hành TikTok Shop US/EU mảng thời trang nữ (2025-2026), tư vấn cho seller dropship hàng SHEIN.
Bạn nhận số liệu tổng hợp của một shop và đưa ra nhận định NGẮN GỌN, THỰC TẾ, có thể hành động ngay.

YÊU CẦU:
- Trả lời hoàn toàn bằng TIẾNG VIỆT.
- Mỗi mục là các gạch đầu dòng ngắn (tối đa ~12 mục/list), cụ thể, tránh nói chung chung.
- "goi_y_san_pham": gợi ý loại sản phẩm cụ thể nên list thêm để bổ trợ cho ngách hiện tại của shop.
- "goi_y_ngach": gợi ý ngách (category) mới nên mở rộng hoặc nên gom lại nếu đang loạn.
- "can_toi_uu": ưu tiên theo mức ảnh hưởng (title, ảnh, ngách, giá, tồn kho).
- "tom_tat": 1-2 câu nhận định tổng thể về shop.
- Dựa vào số liệu được cung cấp, KHÔNG bịa số liệu shop không có.
`.trim();

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    uu_diem: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    nhuoc_diem: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    can_toi_uu: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    goi_y_san_pham: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    goi_y_ngach: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    tom_tat: { type: SchemaType.STRING },
  },
  required: [
    "uu_diem",
    "nhuoc_diem",
    "can_toi_uu",
    "goi_y_san_pham",
    "goi_y_ngach",
    "tom_tat",
  ],
} as const;

export async function analyzeShop(
  input: ShopAnalysisInput
): Promise<ShopAnalysisResult | null> {
  const prompt = buildPrompt(input);

  const cached = await geminiCache.getAnalysis(prompt);
  if (cached) {
    try {
      console.log(`💾 [Analysis Cache] Hit: shop "${input.shopName}"`);
      return JSON.parse(cached) as ShopAnalysisResult;
    } catch {
      // cache hỏng → bỏ qua, gọi lại
    }
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA as any,
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    const text = result.response.text();
    const parsed = JSON.parse(text) as ShopAnalysisResult;
    await geminiCache.setAnalysis(prompt, text);
    return parsed;
  } catch (error) {
    console.error("analyzeShop failed:", error);
    return null;
  }
}
