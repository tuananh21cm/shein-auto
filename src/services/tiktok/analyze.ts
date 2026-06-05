import type { CrawlSnapshot, AnalysisResult } from "./types";
import type { MetricRow } from "./db";
import { callClaude as realCallClaude } from "../anthropic/client";

const SYSTEM = `Bạn là chuyên gia vận hành TikTok Shop US. Phân tích chỉ số shop hằng ngày.
Trả về DUY NHẤT một JSON đúng schema (không markdown, không giải thích ngoài JSON):
{
  "summary": "tóm tắt 2-3 câu tình hình hôm nay",
  "alerts": [{"severity":"high|medium|low","title":"","detail":"","action":"việc cần làm"}],
  "strengths": ["điểm mạnh"],
  "weaknesses": ["điểm yếu"],
  "todos": [{"priority":1,"task":"","why":""}]
}
Ưu tiên cảnh báo chỉ số xấu đi so với hôm qua. todos sắp theo priority tăng dần (1 = gấp nhất).`;

export function buildUserPrompt(today: CrawlSnapshot, yesterday: MetricRow[]): string {
  const todayMetrics = today.routes.flatMap((r) =>
    r.metrics.map((m) => ({ route: r.route, ...m }))
  );
  return JSON.stringify(
    { today: { date: today.runDate, status: today.status, metrics: todayMetrics }, yesterday },
    null,
    2
  );
}

export function parseAnalysis(text: string): AnalysisResult {
  const empty: AnalysisResult = {
    summary: "(AI không phân tích được — chỉ có số liệu thô)",
    alerts: [], strengths: [], weaknesses: [], todos: [],
  };
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) return empty;
    const obj = JSON.parse(raw.slice(start, end + 1));
    return {
      summary: String(obj.summary ?? empty.summary),
      alerts: Array.isArray(obj.alerts) ? obj.alerts : [],
      strengths: Array.isArray(obj.strengths) ? obj.strengths : [],
      weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses : [],
      todos: Array.isArray(obj.todos) ? obj.todos : [],
    };
  } catch {
    return empty;
  }
}

export interface AnalyzeDeps {
  callClaude?: (p: { system: string; user: string; model?: string }) => Promise<string>;
  model?: string;
}

export async function analyzeSnapshot(
  today: CrawlSnapshot,
  yesterday: MetricRow[],
  deps: AnalyzeDeps = {}
): Promise<AnalysisResult> {
  const call = deps.callClaude ?? realCallClaude;
  const user = buildUserPrompt(today, yesterday);
  try {
    const text = await call({ system: SYSTEM, user, model: deps.model });
    return parseAnalysis(text);
  } catch (e: any) {
    return {
      summary: `(Lỗi gọi AI: ${e?.message ?? e})`,
      alerts: [], strengths: [], weaknesses: [], todos: [],
    };
  }
}
