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

describe("listing_views (view per-listing: hôm qua + 7 ngày)", () => {
  const row = (id: string, pv: number, orders = 1) => ({
    productId: id, productName: `SP ${id}`, pv28d: pv, orders28d: orders,
    gmv28d: null, salesTotal: null, stock: 5,
  });

  it("diff hôm qua + mốc 7 ngày, sort theo pv, upsert cùng ngày không duplicate", () => {
    const db = freshDb();
    db.upsertListingViews(1, "Shop A", "2026-06-29", [row("p1", 64), row("p2", 200)]);
    db.upsertListingViews(2, "Shop A", "2026-07-05", [row("p1", 86), row("p2", 190)]);
    db.upsertListingViews(3, "Shop A", "2026-07-06", [row("p1", 94, 2), row("p2", 180), row("p3", 7)]);
    db.upsertListingViews(4, "Shop A", "2026-07-06", [row("p1", 94, 2), row("p2", 180), row("p3", 7)]); // ghi đè

    const t = db.getListingViewTrends("shop a"); // case-insensitive
    expect(t.latestDate).toBe("2026-07-06");
    expect(t.prevDate).toBe("2026-07-05");
    expect(t.weekDate).toBe("2026-06-29");
    expect(t.rows.length).toBe(3);
    expect(t.rows[0].productId).toBe("p2"); // pv cao nhất đứng đầu

    const p1 = t.rows.find((r) => r.productId === "p1")!;
    expect(p1.dDay).toBe(8);        // 94 - 86
    expect(p1.dWeek).toBe(30);      // 94 - 64
    expect(p1.pctWeek).toBe(46.9);  // 30/64
    const p2 = t.rows.find((r) => r.productId === "p2")!;
    expect(p2.dDay).toBe(-10);
    expect(p2.dWeek).toBe(-20);
    const p3 = t.rows.find((r) => r.productId === "p3")!; // SP mới list — chưa có mốc so
    expect(p3.dDay).toBeNull();
    expect(p3.dWeek).toBeNull();
  });

  it("chỉ có 2 ngày liền nhau → mốc 7d fallback = hôm qua", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S2", "2026-07-05", [row("p1", 89)]);
    db.upsertListingViews(2, "S2", "2026-07-06", [row("p1", 94)]);
    const t = db.getListingViewTrends("S2");
    expect(t.weekDate).toBe("2026-07-05");
    expect(t.rows[0].dDay).toBe(5);
    expect(t.rows[0].dWeek).toBe(5);
  });

  it("ngày cũ hơn 7 ngày KHÔNG được lấy làm mốc 7d", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S3", "2026-06-20", [row("p1", 10)]); // 16 ngày trước — ngoài cửa sổ
    db.upsertListingViews(2, "S3", "2026-07-06", [row("p1", 94)]);
    const t = db.getListingViewTrends("S3");
    expect(t.prevDate).toBe("2026-06-20"); // vẫn là ngày gần nhất trước đó
    expect(t.weekDate).toBeNull();         // nhưng không tính là mốc 7d
    expect(t.rows[0].dWeek).toBeNull();
  });

  it("shop chưa có data → rỗng, không crash", () => {
    const db = freshDb();
    const t = db.getListingViewTrends("khong-ton-tai");
    expect(t.latestDate).toBeNull();
    expect(t.rows).toEqual([]);
  });
});
