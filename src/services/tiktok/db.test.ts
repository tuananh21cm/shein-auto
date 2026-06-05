import { describe, it, expect } from "vitest";
import { TiktokDb } from "./db";

function freshDb() {
  return new TiktokDb(":memory:");
}

describe("TiktokDb", () => {
  it("tạo run, ghi metrics, đọc lại snapshot theo ngày", () => {
    const db = freshDb();
    const runId = db.startRun("2026-06-06");
    db.insertMetrics(runId, "homepage", [
      { key: "gmv", valueNum: 100, unit: "USD" },
      { key: "orders", valueNum: 5, unit: "count" },
    ]);
    db.finishRun(runId, "ok");

    const snap = db.getMetricsByDate("2026-06-06");
    expect(snap.find((m) => m.key === "gmv")?.valueNum).toBe(100);
    expect(snap.length).toBe(2);
  });

  it("getMetricsByDate trả [] khi chưa có ngày đó", () => {
    const db = freshDb();
    expect(db.getMetricsByDate("2000-01-01")).toEqual([]);
  });

  it("lưu alerts + report", () => {
    const db = freshDb();
    const runId = db.startRun("2026-06-06");
    db.insertAlerts(runId, [{ severity: "high", title: "GMV giảm", action: "xem ads" }]);
    db.insertReport(runId, "docs/reports/2026-06-06-tiktok.md", "claude-opus-4-8");
    const alerts = db.getAlertsByRun(runId);
    expect(alerts[0].severity).toBe("high");
  });
});
