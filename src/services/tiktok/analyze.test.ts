import { describe, it, expect } from "vitest";
import { parseAnalysis, analyzeSnapshot } from "./analyze";
import type { CrawlSnapshot } from "./types";

describe("parseAnalysis", () => {
  it("parse JSON thuần", () => {
    const r = parseAnalysis('{"summary":"ok","alerts":[],"strengths":[],"weaknesses":[],"todos":[]}');
    expect(r.summary).toBe("ok");
  });
  it("parse JSON bọc trong ```json fence", () => {
    const r = parseAnalysis('```json\n{"summary":"x","alerts":[],"strengths":[],"weaknesses":[],"todos":[]}\n```');
    expect(r.summary).toBe("x");
  });
  it("fallback an toàn khi rác", () => {
    const r = parseAnalysis("không phải json");
    expect(r.summary).toContain("không phân tích được");
    expect(r.alerts).toEqual([]);
  });
});

describe("analyzeSnapshot", () => {
  it("dùng callClaude inject + trả AnalysisResult", async () => {
    const snap: CrawlSnapshot = {
      runId: 1, runDate: "2026-06-06", startedAt: "", finishedAt: "", status: "ok",
      routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100 }] }],
    };
    const fakeCall = async () => '{"summary":"tốt","alerts":[{"severity":"high","title":"t"}],"strengths":[],"weaknesses":[],"todos":[]}';
    const r = await analyzeSnapshot(snap, [], { callClaude: fakeCall, model: "test" });
    expect(r.summary).toBe("tốt");
    expect(r.alerts[0].severity).toBe("high");
  });
});
