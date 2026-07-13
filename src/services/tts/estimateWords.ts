/**
 * Fallback khi Edge TTS không trả WordBoundary metadata: ước lượng timestamp
 * từng từ bằng cách chia duration audio theo trọng số (số ký tự + 1).
 * Đủ tốt cho caption TikTok (lệch < ~200ms); có metadata thật thì không dùng.
 */
export interface TtsWord {
  text: string;
  startMs: number;
  endMs: number;
}

export function estimateWordTimings(text: string, durationMs: number): TtsWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: TtsWord[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const end = i === tokens.length - 1
      ? durationMs
      : Math.round(cursor + (weights[i] / total) * durationMs);
    out.push({ text: tokens[i], startMs: Math.round(cursor), endMs: end });
    cursor = end;
  }
  return out;
}
