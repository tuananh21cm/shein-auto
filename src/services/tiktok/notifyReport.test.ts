import { describe, it, expect } from "vitest";
import { chunkText, renderTelegram } from "./notifyReport";
import type { CrawlSnapshot, AnalysisResult } from "./types";

describe("chunkText", () => {
  it("text ngắn → 1 đoạn", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });
  it("tách theo dòng, mỗi đoạn <= maxLen", () => {
    const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
    const chunks = chunkText(text, 10); // mỗi đoạn ~2 dòng
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.join("\n")).toBe(text);
  });
  it("cắt cứng dòng dài hơn maxLen", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe("x".repeat(25));
  });
});

describe("renderTelegram", () => {
  const snap = { runDate: "2026-06-06", status: "ok", routes: [] } as unknown as CrawlSnapshot;
  const a: AnalysisResult = {
    overallStatus: "critical",
    summary: "Shop có 2 vi phạm critical.",
    areas: [{ area: "Sức khỏe", status: "critical", note: "AHR 189, 2 critical" }],
    trends: [],
    alerts: [{ severity: "high", title: "2 vi phạm critical", action: "vào Compliance" }],
    todos: [{ priority: 1, task: "Ship 4 đơn quá hạn" }, { priority: 2, task: "Xử lý vi phạm" }],
  };
  it("gọn, có emoji status, KHÔNG ký hiệu markdown (## ** |)", () => {
    const t = renderTelegram(snap, a, "docs/reports/x.md");
    expect(t).toContain("🔴 TIKTOK SHOP · 2026-06-06 · NGHIÊM TRỌNG");
    expect(t).toContain("🔴 Sức khỏe");
    expect(t).toContain("2 vi phạm critical");
    expect(t).toContain("Ship 4 đơn quá hạn");
    expect(t).toContain("📄 docs/reports/x.md");
    // không còn cú pháp markdown gây rối
    expect(t).not.toMatch(/##|\*\*|\| *---/);
  });
});
