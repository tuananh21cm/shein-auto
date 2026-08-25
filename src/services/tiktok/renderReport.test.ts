import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./renderReport";
import type { CrawlSnapshot, AnalysisResult } from "./types";

const snap: CrawlSnapshot = {
  runId: 1, runDate: "2026-06-06", startedAt: "2026-06-06T01:00:00Z",
  finishedAt: "2026-06-06T01:05:00Z", status: "ok",
  routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100, unit: "USD" }] }],
};
const analysis: AnalysisResult = {
  overallStatus: "warning",
  summary: "Shop ổn nhưng conversion thấp.",
  areas: [
    { area: "Sức khỏe", status: "good", note: "AHR 189, không vi phạm mới" },
    { area: "Doanh số", status: "warning", note: "conversion 1.68% thấp" },
  ],
  trends: [{ label: "Doanh thu", direction: "up", note: "+25% vs hôm qua" }],
  alerts: [{ severity: "high", title: "Tỷ lệ hoàn cao", action: "kiểm tra sản phẩm A" }],
  todos: [{ priority: 1, task: "Bật ads", why: "tăng GMV" }],
};

describe("renderMarkdown (overview)", () => {
  it("render tiêu đề + status tổng + scorecard + xu hướng + alert + todo", () => {
    const md = renderMarkdown(snap, analysis, []);
    expect(md).toContain("# TikTok Shop — Overview 2026-06-06");
    expect(md).toContain("Tình trạng chung");
    expect(md).toContain("Shop ổn nhưng conversion thấp.");
    expect(md).toContain("Sức khỏe theo mảng");
    expect(md).toContain("AHR 189");
    expect(md).toContain("Xu hướng");
    expect(md).toContain("Doanh thu");
    expect(md).toContain("Tỷ lệ hoàn cao");
    expect(md).toContain("Bật ads");
    expect(md).toContain("Chi tiết chỉ số");
    expect(md).toContain("gmv");
  });

  it("hiện Δ so hôm qua trong chi tiết khi có số liệu cũ", () => {
    const md = renderMarkdown(snap, analysis, [{ route: "homepage", key: "gmv", valueNum: 80, unit: "USD" }]);
    expect(md).toMatch(/\+20|\+25%/);
  });
});
