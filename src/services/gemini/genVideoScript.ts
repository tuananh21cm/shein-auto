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
  /** Câu "open loop" nói ngay sau hook — hứa payoff ở cuối để giữ chân xem hết. */
  openLoop?: string;
  lines: string[];
  cta: string;
}

/** Validate + chuẩn hóa output LLM. Throw nếu thiếu trường bắt buộc. */
export function validateScript(raw: any): VideoScript {
  const hook = String(raw?.hook ?? "").trim();
  const openLoop = String(raw?.openLoop ?? "").trim() || undefined;
  const cta = String(raw?.cta ?? "").trim();
  let lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l: any) => String(l).trim()).filter(Boolean);
  if (!hook) throw new Error("Script thiếu hook");
  if (!lines.length) throw new Error("Script thiếu lines");
  if (!cta) throw new Error("Script thiếu cta");
  // Cap tổng ~110 từ: bỏ dần lines cuối (giữ hook + cta) để voiceover không quá 40s.
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let total = wc(hook) + wc(cta) + (openLoop ? wc(openLoop) : 0) + lines.reduce((a: number, l: string) => a + wc(l), 0);
  while (total > 110 && lines.length > 1) {
    total -= wc(lines[lines.length - 1]);
    lines = lines.slice(0, -1);
  }
  return { hook, openLoop, lines, cta };
}

/** Text đầy đủ đưa vào TTS (openLoop nói ngay sau hook). */
export const scriptToText = (s: VideoScript): string =>
  [s.hook, ...(s.openLoop ? [s.openLoop] : []), ...s.lines, s.cta].join(" ").replace(/\s+/g, " ").trim();

export async function genVideoScript(title: string, extras?: { price?: string; attributes?: string }): Promise<VideoScript> {
  const systemInstruction = `
    You write 30-second TikTok Shop US product video voiceover scripts (2025-2026 style).
    The video shows close-up product photos with Ken Burns zoom effects.
    GOAL: maximum watch-time retention — viewer must want to watch to the END.
    RULES:
    - "hook": <= 10 words, pattern-interrupt opener. Pick ONE formula that fits the product:
      (a) audience callout: "If you're obsessed with [X], stop scrolling"
      (b) curiosity gap: "Nobody talks about this [product] secret"
      (c) tease: "Wait till you see the [detail]"
      (d) bold claim: "This is the most flattering [product] of 2026"
      (e) POV: "POV: you finally found [outcome]". No emoji.
    - "openLoop": <= 12 words, spoken RIGHT AFTER the hook. Promise a specific payoff
      that comes at the END ("stay till the end for the best part", "the last detail sold me").
    - "lines": 3-5 short spoken sentences selling the product: material/fit feel, occasions
      to wear, why it's trending. The LAST line MUST deliver the openLoop payoff explicitly.
      Casual spoken English, contractions OK.
    - "cta": <= 12 words, urgency + tap-the-cart style call to action.
    - Total across hook+openLoop+lines+cta: 70-100 words (about 30 seconds spoken).
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
          openLoop: { type: SchemaType.STRING },
          lines: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          cta: { type: SchemaType.STRING },
        },
        required: ["hook", "openLoop", "lines", "cta"],
      },
    },
  });

  const result = await retryGemini(() => model.generateContent(prompt));
  return validateScript(JSON.parse(result.response.text()));
}
