import { describe, it, expect } from "vitest";
import { parseAnalysis, analyzeSnapshot } from "./analyze";
import type { CrawlSnapshot } from "./types";

describe("parseAnalysis", () => {
  it("parse JSON thuần (shape overview)", () => {
    const r = parseAnalysis('{"overallStatus":"good","summary":"ok","areas":[{"area":"Sức khỏe","status":"good","note":"n"}],"trends":[],"alerts":[],"todos":[]}');
    expect(r.summary).toBe("ok");
    expect(r.overallStatus).toBe("good");
    expect(r.areas[0].area).toBe("Sức khỏe");
  });
  it("parse JSON bọc trong ```json fence", () => {
    const r = parseAnalysis('```json\n{"overallStatus":"warning","summary":"x","areas":[],"trends":[],"alerts":[],"todos":[]}\n```');
    expect(r.summary).toBe("x");
  });
  it("fallback an toàn khi rác", () => {
    const r = parseAnalysis("không phải json");
    expect(r.summary).toContain("không phân tích được");
    expect(r.alerts).toEqual([]);
    expect(r.areas).toEqual([]);
  });
  it("default field thiếu", () => {
    const r = parseAnalysis('{"summary":"chỉ có summary"}');
    expect(r.summary).toBe("chỉ có summary");
    expect(r.areas).toEqual([]);
    expect(r.overallStatus).toBe("warning");
  });
});

describe("analyzeSnapshot", () => {
  it("dùng callClaude inject + trả AnalysisResult", async () => {
    const snap: CrawlSnapshot = {
      runId: 1, runDate: "2026-06-06", startedAt: "", finishedAt: "", status: "ok",
      routes: [{ route: "homepage", ok: true, metrics: [{ key: "gmv", valueNum: 100 }] }],
    };
    const fakeCall = async () => '{"overallStatus":"critical","summary":"tốt","areas":[],"trends":[],"alerts":[{"severity":"high","title":"t"}],"todos":[]}';
    const r = await analyzeSnapshot(snap, [], { callClaude: fakeCall, model: "test" });
    expect(r.summary).toBe("tốt");
    expect(r.overallStatus).toBe("critical");
    expect(r.alerts[0].severity).toBe("high");
  });
});
