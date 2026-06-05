import type { CrawlSnapshot, AnalysisResult } from "./types";
import type { MetricRow } from "./db";

const SEV_ICON: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

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
  lines.push(`# TikTok Shop — Báo cáo ${snap.runDate}`);
  lines.push("");
  lines.push(`> Trạng thái crawl: **${snap.status}** · ${snap.startedAt} → ${snap.finishedAt}`);
  lines.push("");
  lines.push(`## Tóm tắt`);
  lines.push(a.summary);
  lines.push("");

  lines.push(`## Chỉ số`);
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

  if (a.alerts.length) {
    lines.push(`## ⚠️ Cảnh báo`);
    for (const al of a.alerts) {
      lines.push(`- ${SEV_ICON[al.severity] ?? "•"} **${al.title}**${al.detail ? ` — ${al.detail}` : ""}${al.action ? ` → _${al.action}_` : ""}`);
    }
    lines.push("");
  }

  if (a.strengths.length) {
    lines.push(`## ✅ Điểm mạnh`);
    a.strengths.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (a.weaknesses.length) {
    lines.push(`## ❌ Điểm yếu`);
    a.weaknesses.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (a.todos.length) {
    lines.push(`## 📋 Việc cần làm`);
    [...a.todos].sort((x, y) => x.priority - y.priority).forEach((t) =>
      lines.push(`${t.priority}. **${t.task}**${t.why ? ` — ${t.why}` : ""}`)
    );
    lines.push("");
  }

  return lines.join("\n");
}
