/**
 * researchInsights (P4) — dùng Gemini phân tích kết quả research trong 1 CALL DUY NHẤT:
 *   1. briefing       — 3-5 câu nhận định ngày (ngách nóng, mùa vụ US, nên ưu tiên gì)
 *   2. niche_suggestions — 3-5 ngách MỚI nên thử (key + query search + lý do)
 *   3. candidate_notes  — lý do bán hàng tiếng Việt, súc tích cho từng sp (theo goods_id)
 *
 * Gộp 1 call để tiết kiệm token (không gọi /sp). Kết quả ghi vào Signal Store:
 * briefing+suggestions → research_briefing; notes → research_candidate.ai_reason.
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { researchStore, today } from "../../state/researchStore";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface BriefingResult {
  day: string;
  briefing: string;
  suggestions: { key: string; query: string; why: string }[];
  notesApplied: number;
  candidatesAnalyzed: number;
}

export async function generateResearchBriefing(
  opts: { day?: string; maxCandidates?: number; onLog?: (m: string) => void } = {}
): Promise<BriefingResult> {
  const day = opts.day ?? today();
  const log = opts.onLog ?? (() => {});
  const maxCandidates = opts.maxCandidates ?? 40;

  const niches = researchStore.listNiches(day);
  const { items: candidates } = researchStore.listCandidates({ day, limit: maxCandidates });
  if (!candidates.length) {
    throw new Error("Chưa có candidate ngày này — chạy research trước đã.");
  }

  // Input gọn cho Gemini
  const nicheLines = niches
    .map((n) => `${n.nicheKey}: nhiệt ${n.heatScore}, ${n.supplyCount} sp, giá median $${n.medianPrice ?? "-"}`)
    .join("\n");
  const candLines = candidates
    .map((c) => {
      const sold = c.soldText ? ` sold=${c.soldText}` : "";
      const disc = ""; // discount không lưu ở candidate, bỏ qua
      return `${c.goodsId} | ${c.nicheKey} | win=${c.winScore} opp=${c.opportunityScore} | $${c.finalPrice ?? "-"} | ${c.commentNum}rv${c.rating ? " ★" + c.rating : ""}${sold}${disc} | ${(c.name || "").slice(0, 70)}`;
    })
    .join("\n");

  const systemInstruction = `
Bạn là chuyên gia chọn hàng (product sourcing) cho người bán dropship TikTok Shop thị trường US, mảng thời trang nữ 2025-2026.
Bạn nhận danh sách sản phẩm "win" cào từ SHEIN US đã chấm điểm (win = độ hot trên SHEIN, opp = điểm đáng đăng đã tính cả nhiệt ngách & biên giá).
NHIỆM VỤ: phân tích thực chiến, NGẮN GỌN, bằng TIẾNG VIỆT, giúp người bán quyết định đăng gì hôm nay.
Bối cảnh: thị trường US. Cân nhắc mùa vụ theo ngày được cung cấp (vd tháng 5-8 = hè → swim/dress/đồ mát).
Nguyên tắc:
- briefing: 3-5 câu. Nêu ngách đang nóng, góc mùa vụ, và 2-3 sp đáng ưu tiên (nêu lý do).
- niche_suggestions: 3-5 ngách MỚI chưa có trong danh sách, hợp mùa/trend US. query = cụm search SHEIN tiếng Anh.
- candidate_notes: với MỖI goods_id, 1 câu (<=140 ký tự) vì sao nên đăng / bán cho ai / điểm mạnh. Không bịa số liệu.
`.trim();

  const prompt = `NGÀY: ${day}

NHIỆT NGÁCH:
${nicheLines}

CANDIDATE (goods_id | ngách | điểm | giá bán | review/rating/sold | tên):
${candLines}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          briefing: { type: SchemaType.STRING, description: "3-5 câu nhận định tiếng Việt" },
          niche_suggestions: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                key: { type: SchemaType.STRING },
                query: { type: SchemaType.STRING },
                why: { type: SchemaType.STRING },
              },
              required: ["key", "query", "why"],
            },
          },
          candidate_notes: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                goods_id: { type: SchemaType.STRING },
                note: { type: SchemaType.STRING },
              },
              required: ["goods_id", "note"],
            },
          },
        },
        required: ["briefing", "niche_suggestions", "candidate_notes"],
      },
    },
  });

  log(`🤖 Gemini phân tích ${candidates.length} candidate · ${niches.length} ngách…`);
  const result = await retryGemini(() => model.generateContent(prompt));
  const data = JSON.parse(result.response.text());

  const briefing: string = data.briefing ?? "";
  const suggestions = Array.isArray(data.niche_suggestions) ? data.niche_suggestions : [];
  const notes: Record<string, string> = {};
  for (const n of data.candidate_notes ?? []) {
    if (n?.goods_id && n?.note) notes[String(n.goods_id)] = String(n.note);
  }

  researchStore.saveBriefing(day, briefing, suggestions);
  const notesApplied = researchStore.applyAiReasons(day, notes);

  log(`✅ AI xong: briefing + ${suggestions.length} ngách gợi ý + ${notesApplied} ghi chú candidate.`);
  return { day, briefing, suggestions, notesApplied, candidatesAnalyzed: candidates.length };
}
