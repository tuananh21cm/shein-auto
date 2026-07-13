/**
 * Gen script video TikTok (EN) từ title sản phẩm: {hook, lines[], cta}.
 * Tổng ~70-100 từ ≈ 25-35s voiceover. Model + retry pattern giống genTitleFromShein.
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface VideoScript {
  hook: string;
  lines: string[];
  cta: string;
}

/** Validate + chuẩn hóa output LLM. Throw nếu thiếu trường bắt buộc. */
export function validateScript(raw: any): VideoScript {
  const hook = String(raw?.hook ?? "").trim();
  const cta = String(raw?.cta ?? "").trim();
  let lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l: any) => String(l).trim()).filter(Boolean);
  if (!hook) throw new Error("Script thiếu hook");
  if (!lines.length) throw new Error("Script thiếu lines");
  if (!cta) throw new Error("Script thiếu cta");
  // Cap tổng ~110 từ: bỏ dần lines cuối (giữ hook + cta) để voiceover không quá 40s.
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let total = wc(hook) + wc(cta) + lines.reduce((a: number, l: string) => a + wc(l), 0);
  while (total > 110 && lines.length > 1) {
    total -= wc(lines[lines.length - 1]);
    lines = lines.slice(0, -1);
  }
  return { hook, lines, cta };
}

/** Text đầy đủ đưa vào TTS. */
export const scriptToText = (s: VideoScript): string =>
  [s.hook, ...s.lines, s.cta].join(" ").replace(/\s+/g, " ").trim();

export async function genVideoScript(title: string, extras?: { price?: string; attributes?: string }): Promise<VideoScript> {
  const systemInstruction = `
    You write 30-second TikTok Shop US product video voiceover scripts (2025-2026 style).
    The video shows close-up product photos with Ken Burns zoom effects.
    RULES:
    - "hook": <= 10 words, pattern-interrupt opener (question, bold claim, or "POV:"). No emoji.
    - "lines": 3-5 short spoken sentences selling the product: material/fit feel, occasions to wear, why it's trending. Casual spoken English, contractions OK.
    - "cta": <= 12 words, urgency + tap-the-cart style call to action.
    - Total across hook+lines+cta: 70-100 words (about 30 seconds spoken).
    - NO brand/supplier names (SHEIN etc.), no prices unless provided, no hashtags, no emoji.
  `;
  const prompt = `Product title: ${title}` +
    (extras?.price ? `\nPrice: ${extras.price}` : "") +
    (extras?.attributes ? `\nAttributes: ${extras.attributes}` : "");

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          hook: { type: SchemaType.STRING },
          lines: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          cta: { type: SchemaType.STRING },
        },
        required: ["hook", "lines", "cta"],
      },
    },
  });

  const result = await retryGemini(() => model.generateContent(prompt));
  return validateScript(JSON.parse(result.response.text()));
}
