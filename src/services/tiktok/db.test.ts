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

describe("getSlowGrowthListings (ứng viên xóa: view thấp + tăng ~0 + ≥N ngày + 0 đơn)", () => {
  const row = (id: string, pv: number, orders = 0, stock = 100) => ({
    productId: id, productName: `SP ${id}`, pv28d: pv, orders28d: orders,
    gmv28d: null, salesTotal: null, stock,
  });

  it("bắt sp lên chậm, loại sp mới (chưa đủ ngày), loại sp có đơn / view cao", () => {
    const db = freshDb();
    // dead1: track từ 07-01 → 07-08 (7 ngày), pv 5→12 (+1/ngày), 0 đơn → ỨNG VIÊN
    db.upsertListingViews(1, "S", "2026-07-01", [row("dead1", 5), row("has-order", 8, 0), row("bigview", 900)]);
    db.upsertListingViews(2, "S", "2026-07-08", [
      row("dead1", 12, 0),        // +1/ngày, 0 đơn, 7 ngày → ứng viên
      row("has-order", 15, 3),    // có đơn → loại
      row("bigview", 950),        // view cao → loại
      row("new1", 4, 0),          // MỚI xuất hiện 07-08 → track 0 ngày → loại (tránh giết sp mới)
    ]);
    const r = db.getSlowGrowthListings("S", { maxPv: 30, minDays: 7, maxAvgPerDay: 2 });
    expect(r.candidates.map((c) => c.productId)).toEqual(["dead1"]);
    const c = r.candidates[0];
    expect(c.daysTracked).toBe(7);
    expect(c.firstPv).toBe(5);
    expect(c.pv).toBe(12);
    expect(c.avgPerDay).toBe(1); // (12-5)/7
  });

  it("chưa đủ minDays → không bắt ai (không giết sp mới), historyDays báo đúng", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S2", "2026-07-07", [row("p", 2)]);
    db.upsertListingViews(2, "S2", "2026-07-08", [row("p", 3)]); // track 1 ngày
    const r = db.getSlowGrowthListings("S2", { minDays: 7 });
    expect(r.candidates).toEqual([]);
    expect(r.historyDays).toBe(2);
  });

  it("sp tăng nhanh KHÔNG bị bắt dù view thấp", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S3", "2026-07-01", [row("ramp", 2)]);
    db.upsertListingViews(2, "S3", "2026-07-08", [row("ramp", 25)]); // +23/7 ≈ 3.3/ngày > 2
    const r = db.getSlowGrowthListings("S3", { maxPv: 30, minDays: 7, maxAvgPerDay: 2 });
    expect(r.candidates).toEqual([]);
  });

  it("shop chưa có data → rỗng", () => {
    const db = freshDb();
    const r = db.getSlowGrowthListings("none");
    expect(r.latestDate).toBeNull();
    expect(r.candidates).toEqual([]);
  });
});

describe("getRisingListings (view đang lên: scale/ads/bổ hàng)", () => {
  const row = (id: string, pv: number, orders = 0, stock = 100) => ({
    productId: id, productName: `SP ${id}`, pv28d: pv, orders28d: orders,
    gmv28d: null, salesTotal: null, stock,
  });

  it("bắt sp tăng nhanh, gắn cờ converting + lowStock, sắp theo đà mạnh nhất", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S", "2026-07-01", [row("fast", 100), row("slow", 100), row("hot-lowstock", 100)]);
    db.upsertListingViews(2, "S", "2026-07-08", [
      row("fast", 940, 5),               // +840/7 = +120/ngày, có đơn → converting
      row("slow", 130),                  // +30/7 ≈ 4.3/ngày < 15 → KHÔNG lên
      row("hot-lowstock", 800, 0, 12),   // +700/7 = +100/ngày, tồn 12 ≤ 20 → lowStock
    ]);
    const r = db.getRisingListings("S", { minAvgPerDay: 15, minDays: 7, lowStockAt: 20 });
    expect(r.risers.map((x) => x.productId)).toEqual(["fast", "hot-lowstock"]); // sắp theo avgPerDay desc
    expect(r.summary).toEqual({ total: 2, converting: 1, lowStock: 1 });
    const fast = r.risers.find((x) => x.productId === "fast")!;
    expect(fast.converting).toBe(true);
    expect(fast.avgPerDay).toBe(120);
    const hot = r.risers.find((x) => x.productId === "hot-lowstock")!;
    expect(hot.lowStock).toBe(true);
    expect(hot.converting).toBe(false);
  });

  it("chưa đủ minDays → rỗng, historyDays đúng", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S2", "2026-07-07", [row("p", 10)]);
    db.upsertListingViews(2, "S2", "2026-07-08", [row("p", 900)]); // track 1 ngày
    const r = db.getRisingListings("S2", { minDays: 3 });
    expect(r.risers).toEqual([]);
    expect(r.historyDays).toBe(2);
  });

  it("shop chưa có data → rỗng", () => {
    const db = freshDb();
    const r = db.getRisingListings("none");
    expect(r.latestDate).toBeNull();
    expect(r.risers).toEqual([]);
    expect(r.summary.total).toBe(0);
  });
});

describe("getFlashCandidates (chọn sp vào flash: top-view ∪ đang lên ∪ có đơn, né 7d-tăng-ít)", () => {
  const row = (id: string, pv: number, orders = 0, stock = 100) => ({
    productId: id, productName: `SP ${id}`, pv28d: pv, orders28d: orders,
    gmv28d: null, salesTotal: null, stock,
  });

  it("giữ sp có tín hiệu, loại sp không tín hiệu (7d tăng ít), sắp có-đơn trước", () => {
    const db = freshDb();
    db.upsertListingViews(1, "S", "2026-07-01", [
      row("seller", 100), row("rising", 100), row("topview", 700), row("flat", 40),
    ]);
    db.upsertListingViews(2, "S", "2026-07-08", [
      row("seller", 130, 4),   // có đơn (avgPerDay ~4) → giữ (converting)
      row("rising", 240),      // +140/7 = +20/ngày ≥15 → đang lên → giữ
      row("topview", 720),     // pv 720 ≥ 500 → nhiều view → giữ
      row("flat", 45),         // +5/7≈0.7/ngày, 0 đơn, pv 45 <500 → KHÔNG tín hiệu → loại
    ]);
    const r = db.getFlashCandidates("S", { limit: 30, risingPerDay: 15, topViewPv: 500 });
    const ids = r.candidates.map((c) => c.productId);
    expect(ids).not.toContain("flat");
    expect(ids).toContain("seller");
    expect(ids).toContain("rising");
    expect(ids).toContain("topview");
    expect(r.candidates[0].productId).toBe("seller"); // có đơn lên đầu
    expect(r.candidates.find((c) => c.productId === "rising")!.reasons).toContain("đang lên");
    expect(r.candidates.find((c) => c.productId === "topview")!.reasons).toContain("nhiều view");
  });

  it("cap đúng limit", () => {
    const db = freshDb();
    const first = Array.from({ length: 40 }, (_, i) => row(`p${i}`, 100));
    const second = Array.from({ length: 40 }, (_, i) => row(`p${i}`, 100 + 200 * (i + 1))); // đều đang lên
    db.upsertListingViews(1, "S2", "2026-07-01", first);
    db.upsertListingViews(2, "S2", "2026-07-08", second);
    const r = db.getFlashCandidates("S2", { limit: 30 });
    expect(r.total).toBe(40);
    expect(r.candidates.length).toBe(30);
  });

  it("shop chưa có data → rỗng", () => {
    const db = freshDb();
    const r = db.getFlashCandidates("none");
    expect(r.candidates).toEqual([]);
    expect(r.total).toBe(0);
  });
});
