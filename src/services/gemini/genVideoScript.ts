/**
 * Gen script video TikTok (EN) từ title sản phẩm: {hook, lines[], cta}.
 * Tổng ~70-100 từ ≈ 25-35s voiceover. Model + retry pattern giống genTitleFromShein.
 */
import { callClaudeJSON } from "../anthropic/client";

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

/**
 * Các "kịch bản" hook để A/B test retention — queue random theo seed, lưu vào DB
 * để sau này đối chiếu style nào giữ chân/ra đơn tốt nhất.
 */
export type HookStyle = "social_proof" | "viral" | "tease" | "callout" | "storytime" | "listicle";

export const HOOK_STYLES: Record<HookStyle, string> = {
  social_proof: `Open with sales/popularity momentum ("here's why everyone's ordering this").
    If "Stats" numbers are provided in the prompt, lead the hook with those REAL numbers
    (e.g. "2,000 of you viewed this last month"). If NO stats are provided, use hot-but-unverifiable
    phrasing ("orders keep rolling in", "almost sold out again") — do NOT invent specific numbers.
    Structure: hook momentum → "here's why" → 3 reasons, the BEST reason LAST.`,
  viral: `Open like the product is blowing up on TikTok ("TikTok made me buy it",
    "you've seen this everywhere this week"). FOMO energy, trend language, casual confession tone.`,
  tease: `Open by teasing ONE specific detail that is only revealed at the END
    ("wait till you see the back"). openLoop promises it, the LAST line reveals it.`,
  callout: `Open by calling out the exact target buyer's pain point
    ("If every dress swallows your waist, stop scrolling"). Then position the product as the fix,
    with the strongest proof at the end.`,
  storytime: `Open mid-story in first person ("Three strangers stopped me at brunch over this").
    Tell a mini story across the lines; the story's punchline lands in the LAST line.`,
  listicle: `Open with a numbered promise ("3 reasons this is THE dress of summer").
    Each line starts "One:", "Two:", "Three:" — the viewer stays to hear the last number.
    Put the most surprising reason at number three.`,
};

export async function genVideoScript(
  title: string,
  extras?: { price?: string; attributes?: string; stats?: { pv28d?: number; orders28d?: number } },
  style: HookStyle = "tease"
): Promise<VideoScript> {
  const systemInstruction = `
    You write 30-second TikTok Shop US product video voiceover scripts (2025-2026 style).
    The video shows close-up product photos with Ken Burns zoom effects.
    GOAL: maximum watch-time retention — viewer must want to watch to the END.

    HOOK SCENARIO for this script (follow it strictly):
    ${HOOK_STYLES[style]}

    RULES:
    - "hook": <= 12 words, pattern-interrupt opener following the scenario above. No emoji.
    - "openLoop": <= 12 words, spoken RIGHT AFTER the hook. Promise a specific payoff
      that comes at the END ("stay till the end for the best part", "number three sold me").
    - "lines": 3-5 short spoken sentences selling the product: material/fit feel, occasions
      to wear, why it's trending. The LAST line MUST deliver the openLoop payoff explicitly.
      Casual spoken English, contractions OK.
    - "cta": <= 12 words, urgency + tap-the-cart style call to action.
    - Total across hook+openLoop+lines+cta: 70-100 words (about 30 seconds spoken).
    - NO brand/supplier names (SHEIN etc.), no hashtags, no emoji. Prices only if provided.

    OUTPUT JSON SHAPE: {"hook": "...", "openLoop": "...", "lines": ["...", "..."], "cta": "..."}
  `;
  const stats = extras?.stats;
  const statsLine = stats && (stats.pv28d || stats.orders28d)
    ? `\nStats (REAL, last 28 days): ${stats.pv28d ? `${stats.pv28d} product views` : ""}${stats.pv28d && stats.orders28d ? ", " : ""}${stats.orders28d ? `${stats.orders28d} orders` : ""}`
    : "";
  const prompt = `Product title: ${title}` +
    (extras?.price ? `\nPrice: ${extras.price}` : "") +
    (extras?.attributes ? `\nAttributes: ${extras.attributes}` : "") +
    statsLine;

  const data = await callClaudeJSON<any>({ system: systemInstruction, user: prompt, maxTokens: 800 });
  return validateScript(data);
}
