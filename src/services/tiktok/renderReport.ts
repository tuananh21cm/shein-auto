import type { CrawlSnapshot, AnalysisResult, HealthStatus } from "./types";
import type { MetricRow } from "./db";

const SEV_ICON: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
const STATUS_ICON: Record<HealthStatus, string> = { good: "🟢", warning: "🟡", critical: "🔴" };
const STATUS_TEXT: Record<HealthStatus, string> = { good: "Tốt", warning: "Cần chú ý", critical: "Nghiêm trọng" };

function delta(today: number, prev: number | null | undefined): string {
  if (prev === null || prev === undefined) return "";
  const d = today - prev;
  const sign = d >= 0 ? "+" : "";
  const pct = prev !== 0 ? ` (${sign}${Math.round((d / prev) * 100)}%)` : "";
  return ` \`${sign}${Math.round(d * 100) / 100}${pct}\``;
}

export function renderMarkdown(
  snap: CrawlSnapshot,
  a: AnalysisResult,
  yesterday: MetricRow[]
): string {
  const prevOf = (route: string, key: string) =>
    yesterday.find((m) => m.route === route && m.key === key)?.valueNum;

  const lines: string[] = [];
  lines.push(`# TikTok Shop — Overview ${snap.runDate}`);
  lines.push("");
  lines.push(`> ${STATUS_ICON[a.overallStatus]} **Tình trạng chung: ${STATUS_TEXT[a.overallStatus]}** · crawl ${snap.status} · ${snap.startedAt} → ${snap.finishedAt}`);
  lines.push("");
  lines.push(a.summary);
  lines.push("");

  // 1. Scorecard sức khỏe theo mảng
  if (a.areas.length) {
    lines.push(`## 📊 Sức khỏe theo mảng`);
    lines.push(`| Mảng | Trạng thái | Nhận xét |`);
    lines.push(`|---|---|---|`);
    for (const ar of a.areas) {
      const icon = STATUS_ICON[ar.status] ?? "⚪";
      lines.push(`| ${ar.area} | ${icon} ${STATUS_TEXT[ar.status] ?? ar.status} | ${ar.note} |`);
    }
    lines.push("");
  }

  // 2. Xu hướng vs hôm qua
  if (a.trends.length) {
    lines.push(`## 📈 Xu hướng (vs hôm qua)`);
    for (const t of a.trends) {
      lines.push(`- ${t.direction === "up" ? "↑" : "↓"} **${t.label}** — ${t.note}`);
    }
    lines.push("");
  }

  // 3. Cảnh báo
  if (a.alerts.length) {
    lines.push(`## ⚠️ Cảnh báo`);
    for (const al of a.alerts) {
      lines.push(`- ${SEV_ICON[al.severity] ?? "•"} **${al.title}**${al.detail ? ` — ${al.detail}` : ""}${al.action ? ` → _${al.action}_` : ""}`);
    }
    lines.push("");
  }

  // 4. Việc cần làm (ưu tiên)
  if (a.todos.length) {
    lines.push(`## 📋 Việc cần làm`);
    [...a.todos].sort((x, y) => x.priority - y.priority).forEach((t) =>
      lines.push(`${t.priority}. **${t.task}**${t.why ? ` — ${t.why}` : ""}`)
    );
    lines.push("");
  }

  // 5. Chi tiết chỉ số (kèm Δ hôm qua)
  lines.push(`## 📑 Chi tiết chỉ số`);
  lines.push(`| Route | Chỉ số | Giá trị | Δ hôm qua |`);
  lines.push(`|---|---|---|---|`);
  for (const r of snap.routes) {
    for (const m of r.metrics) {
      const val = m.valueNum ?? m.valueText ?? "";
      const unit = m.unit && m.unit !== "count" ? ` ${m.unit}` : "";
      const d = m.valueNum != null ? delta(m.valueNum, prevOf(r.route, m.key)) : "";
      lines.push(`| ${r.route} | ${m.key} | ${val}${unit} |${d} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
