import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./renderReport";
import type { CrawlSnapshot, AnalysisResult } from "./types";

const snap: CrawlSnapshot = {
  runId: 1, runDate: "2026-06-06", startedAt: "2026-06-06T01:00:00Z",
  finishedAt: "2026-06-06T01:05:00Z", status: "ok",
  routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100, unit: "USD" }] }],
};
const analysis: AnalysisResult = {
  summary: "GMV ổn định.",
  alerts: [{ severity: "high", title: "Tỷ lệ hoàn cao", action: "kiểm tra sản phẩm A" }],
  strengths: ["traffic tăng"], weaknesses: ["conversion thấp"],
  todos: [{ priority: 1, task: "Bật ads", why: "tăng GMV" }],
};

describe("renderMarkdown", () => {
  it("render tiêu đề + summary + alert + todo", () => {
    const md = renderMarkdown(snap, analysis, []);
    expect(md).toContain("# TikTok Shop — Báo cáo 2026-06-06");
    expect(md).toContain("GMV ổn định.");
    expect(md).toContain("Tỷ lệ hoàn cao");
    expect(md).toContain("Bật ads");
    expect(md).toContain("gmv");
  });

  it("hiện Δ so hôm qua khi có số liệu cũ", () => {
    const md = renderMarkdown(snap, analysis, [{ route: "homepage", key: "gmv", valueNum: 80, unit: "USD" }]);
    expect(md).toMatch(/\+20|\+25%/);
  });
});
