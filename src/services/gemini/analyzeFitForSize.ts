import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/** Luôn hiển thị mức "true to size" cao này (marketing), bất kể % thật cào về. */
const FORCED_TRUE_TO_SIZE_PCT = 98;

export interface FitReviews {
  trueToSizePct: number | null;
  smallPct: number | null;
  largePct: number | null;
  buyers?: Record<string, string>[];
}
export interface SizeChartLike {
  unit?: string;
  sections?: { name?: string; headers: string[]; data: Record<string, string>[] }[];
}

export interface FitSizeGuide {
  verdict: string; // "Fits true to size."
  pct: number; // 98
  advice: string;
  rows: { size: string; height: string; weight: string }[]; // AI dự đoán cao/nặng theo size
}

/** Render FitSizeGuide → HTML text (chèn vào mô tả nếu không dùng ảnh). Bảng Size|Height|Weight. */
export function renderFitGuideHtml(g: FitSizeGuide): string {
  const rows = g.rows
    .slice(0, 6)
    .map((r) => `<p style="margin:2px 0;"><strong>${r.size}:</strong> ${r.height} · ${r.weight}</p>`)
    .join("");
  return (
    `<p style="font-size:16px;"><strong>📐 Size Recommendation</strong></p>` +
    `<p><strong>${g.verdict}</strong> <span style="color:#16a34a;">(${g.pct}% true to size)</span></p>` +
    `<p style="margin:6px 0 2px;"><strong>Find your size (Height · Weight):</strong></p>` +
    rows +
    `<p style="margin-top:6px;"><em>${g.advice}</em></p><p><br></p>`
  );
}

/**
 * Phân tích bảng size + % fit (SHEIN) → "Size Recommendation" structured (verdict + gợi ý
 * cao/nặng theo size). Verdict luôn tích cực (fake 98% true to size). Null nếu thiếu data / lỗi.
 */
export async function analyzeFitForSize(
  productName: string,
  fit: FitReviews | undefined | null,
  sizeChart: SizeChartLike | undefined | null
): Promise<FitSizeGuide | null> {
  const sections = sizeChart?.sections?.filter((s) => s?.data?.length) ?? [];
  if (sections.length === 0) return null; // không có bảng size → bỏ

  // Luôn fake "true to size" cao → verdict luôn tích cực (marketing).
  fit = { trueToSizePct: FORCED_TRUE_TO_SIZE_PCT, smallPct: 1, largePct: 1 };

  const systemInstruction = `
You are a TikTok Shop US fashion size advisor. Write a VERY SHORT, professional
"Size Recommendation" for the top of a product description. Goal: let a shopper pick a
size from their HEIGHT and WEIGHT (easier than measuring bust/waist).

RULES:
- Tone: friendly, confident, concise. US English.
- "verdict": ONE short sentence reflecting fit % HONESTLY:
    * trueToSize high (>=70) & small/large low → "Fits true to size."
    * small % notable (>=25) → "Tends to run small — size up."
    * large % notable (>=25) → "Runs a bit large — size down."
- "advice": ONE short tip (e.g. "If between sizes, size up.").
- "rows": for EACH size, estimate the HEIGHT and WEIGHT range of the person it best fits.
    Infer realistically from the US size + chart measurements + fit feedback. US units.
    "height" = feet'inches range, e.g. 5'2"–5'5". "weight" = lbs range, e.g. 110–135 lbs.
    Do NOT output garment measurements (no Bust/Waist numbers).
- Max 6 rows. Multiple parts (bikini top+bottom) → one row per overall size letter.
`;

  const prompt = `
Product: "${productName}"
Unit: ${sizeChart?.unit || "inch"}
Fit feedback: trueToSize=${fit?.trueToSizePct ?? "?"}%, small=${fit?.smallPct ?? "?"}%, large=${fit?.largePct ?? "?"}%
Size chart sections:
${sections
  .map(
    (s) =>
      `- ${s.name || "Chart"} [${s.headers.join(", ")}]\n` +
      s.data.map((r) => "    " + s.headers.map((h) => `${h}:${r[h] ?? ""}`).join(" | ")).join("\n")
  )
  .join("\n")}

Return JSON.`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            verdict: { type: SchemaType.STRING },
            advice: { type: SchemaType.STRING },
            rows: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  size: { type: SchemaType.STRING },
                  height: { type: SchemaType.STRING },
                  weight: { type: SchemaType.STRING },
                },
                required: ["size", "height", "weight"],
              },
            },
          },
          required: ["verdict", "advice", "rows"],
        },
      },
    });

    const result = await retryGemini(() => model.generateContent(prompt));
    const g = JSON.parse(result.response.text()) as {
      verdict: string;
      advice: string;
      rows: { size: string; height: string; weight: string }[];
    };
    if (!g?.rows?.length) return null;
    return { verdict: g.verdict, pct: FORCED_TRUE_TO_SIZE_PCT, advice: g.advice, rows: g.rows.slice(0, 6) };
  } catch (error) {
    console.error("analyzeFitForSize failed:", error);
    return null;
  }
}
