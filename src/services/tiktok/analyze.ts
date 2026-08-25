import type { CrawlSnapshot, AnalysisResult } from "./types";
import type { MetricRow } from "./db";
import { callClaude as realCallClaude } from "../anthropic/client";

const SYSTEM = `Bạn là chuyên gia vận hành TikTok Shop US. Tổng hợp tình trạng shop hằng ngày thành OVERVIEW.
Trả về DUY NHẤT một JSON đúng schema (không markdown, không giải thích ngoài JSON):
{
  "overallStatus": "good|warning|critical",
  "summary": "1-2 câu tổng quan tình trạng shop hôm nay",
  "areas": [
    {"area":"Sức khỏe","status":"good|warning|critical","note":"nhận xét ngắn + số chốt"},
    {"area":"Vận hành","status":"...","note":"..."},
    {"area":"Doanh số","status":"...","note":"..."},
    {"area":"Marketing","status":"...","note":"..."},
    {"area":"Sản phẩm","status":"...","note":"..."},
    {"area":"Inbox","status":"...","note":"..."}
  ],
  "trends": [{"label":"Doanh thu","direction":"up|down","note":"thay đổi so hôm qua, kèm số/%"}],
  "alerts": [{"severity":"high|medium|low","title":"","detail":"","action":"việc cần làm"}],
  "todos": [{"priority":1,"task":"","why":""}]
}

Map mảng → chỉ số:
- Sức khỏe: ahr_score, violation_*, to_settle_amount
- Vận hành: action_* (ship 24h/overdue/...), orders_to_ship/shipped, return_*
- Doanh số: revenue, gross_revenue, refund_amount, conversion_rate, visitors, page_views
- Marketing: promotions_*, promotion_revenue, campaigns_*
- Sản phẩm: products_total, products_low_stock/out_of_stock/no_views_28d, top_product_*, opportunities_tracked, opp_*
- Inbox: unread_* (violations/policies/account_updates), chat_unread/queue, msg_*

Quy tắc status mỗi mảng: "critical" nếu có vi phạm critical / đơn quá hạn ship / refund cao / tin chính sách chưa đọc; "warning" nếu chỉ số yếu (conversion thấp, nhiều SP 0 view, tồn kho thấp...); "good" nếu ổn. overallStatus = mức xấu nhất trong các mảng.
trends: CHỈ nêu thay đổi ĐÁNG KỂ so với "yesterday" trong data (bỏ qua nếu không có data hôm qua). todos gom mọi mảng, priority tăng dần (1 = gấp nhất).
ĐẶC BIỆT: unread_policies/unread_violations/unread_account_updates > 0 hoặc các mục msg_* (tiêu đề thông báo TikTok) = tín hiệu CHÍNH SÁCH quan trọng → alert mức cao + chiến thuật tuân thủ để tránh phạt/khóa shop.`;

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
    overallStatus: "warning",
    summary: "(AI không phân tích được — chỉ có số liệu thô)",
    areas: [], trends: [], alerts: [], todos: [],
  };
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) return empty;
    const obj = JSON.parse(raw.slice(start, end + 1));
    const status = ["good", "warning", "critical"].includes(obj.overallStatus) ? obj.overallStatus : "warning";
    return {
      overallStatus: status,
      summary: String(obj.summary ?? empty.summary),
      areas: Array.isArray(obj.areas) ? obj.areas : [],
      trends: Array.isArray(obj.trends) ? obj.trends : [],
      alerts: Array.isArray(obj.alerts) ? obj.alerts : [],
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
      overallStatus: "warning",
      summary: `(Lỗi gọi AI: ${e?.message ?? e})`,
      areas: [], trends: [], alerts: [], todos: [],
    };
  }
}
