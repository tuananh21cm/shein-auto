import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Thiếu ANTHROPIC_API_KEY trong .env");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface ClaudeCallParams {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

/** Gọi Claude, trả text. Bật prompt caching cho system (khung ổn định). */
export async function callClaude(params: ClaudeCallParams): Promise<string> {
  const model = params.model ?? "claude-opus-4-8";
  const res = await client().messages.create({
    model,
    max_tokens: params.maxTokens ?? 2048,
    system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: params.user }],
  });
  return res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}
