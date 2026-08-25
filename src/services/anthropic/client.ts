import Anthropic from "@anthropic-ai/sdk";
import { retryGemini as retryLlm } from "../../utils/retryGemini";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Thiếu ANTHROPIC_API_KEY trong .env");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/** Model cho pipeline listing (title/desc/category/fit) — rẻ, volume lớn. Đổi 1 chỗ qua env. */
export const LISTING_MODEL = process.env.CLAUDE_LISTING_MODEL || "claude-haiku-4-5";

export interface ClaudeCallParams {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

/**
 * Gọi Claude và bắt buộc trả JSON hợp lệ. Parse nằm TRONG retry: response rỗng /
 * non-JSON (quá tải, bị cắt token) coi là retryable. System được prompt-cache
 * (template tĩnh dùng lại mọi listing → đọc cache giá 0.1×).
 */
export async function callClaudeJSON<T>(params: ClaudeCallParams): Promise<T> {
  const model = params.model ?? LISTING_MODEL;
  return retryLlm(async () => {
    const res = await client().messages.create({
      model,
      max_tokens: params.maxTokens ?? 2048,
      system: [
        {
          type: "text",
          text: params.system + "\n\nRespond with ONLY the JSON object — no markdown fences, no commentary.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: params.user }],
    });
    let text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (!text) {
      const err: any = new Error(`Claude empty response (stop_reason=${res.stop_reason})`);
      err.retryable = true;
      throw err;
    }
    // Gỡ markdown fence nếu model lỡ bọc ```json ... ```
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return JSON.parse(text) as T;
    } catch {
      const err: any = new Error(
        `Claude returned non-JSON (stop_reason=${res.stop_reason}): ${text.slice(0, 150)}`
      );
      err.retryable = true;
      throw err;
    }
  });
}

/** Gọi Claude, trả text. Bật prompt caching cho system (khung ổn định). */
export async function callClaude(params: ClaudeCallParams): Promise<string> {
  const model = params.model ?? "claude-opus-4-8";
  const res = await client().messages.create({
    model,
    max_tokens: params.maxTokens ?? 4096,
    system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: params.user }],
  });
  return res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}
