import { describe, it, expect } from "vitest";
import { extractHomepage } from "./homepage";
import { extractCompassOverview } from "./compassOverview";
import type { Capture } from "../types";

// Fixtures dựa trên payload THẬT từ discovery 2026-06-05 (đã rút gọn).
const homepageCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v1/account/ahr/score?account_type=2",
    status: 200,
    body: { data: { score: 189 } },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/seller/growth_center/violation/overview/get",
    status: 200,
    body: {
      data: {
        violation_score: 0,
        has_new_violation: false,
        violation_points_v2: [
          { violation_type_key: "performance_overview_violation_type_order_fulfillment", count: 2 },
          { violation_type_key: "performance_overview_violation_type_service_metrics", count: 0 },
          { violation_type_key: "performance_overview_violation_type_policy_compliance", count: 1 },
          { violation_type_key: "performance_overview_violation_type_risk_fraud", count: 2 },
        ],
      },
    },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/pay/statement/stat/info?amount_stat_type=1",
    status: 200,
    body: { data: { to_settle_amount_stat: { amount: { amount: "831", currency: "USD" } } } },
  },
  {
    url: "https://seller-us.tiktok.com/api/fulfillment/na/order/list?aid=4068",
    status: 200,
    body: { data: { total_count: 303, main_orders: [] } },
  },
];

describe("extractHomepage (real fixtures)", () => {
  it("bóc AHR score", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "ahr_score")?.valueNum).toBe(189);
  });
  it("bóc violation score + tổng + critical + fulfillment", () => {
    const m = extractHomepage(homepageCaps);
    expect(m.find((x) => x.key === "violation_score")?.valueNum).toBe(0);
    expect(m.find((x) => x.key === "violation_total")?.valueNum).toBe(5);
    expect(m.find((x) => x.key === "violation_critical")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "violation_fulfillment")?.valueNum).toBe(2);
  });
  it("bóc số tiền chờ settle", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "to_settle_amount")?.valueNum).toBe(831);
  });
  it("bóc tổng đơn", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "orders_total")?.valueNum).toBe(303);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractHomepage([])).toEqual([]);
  });
});

// Compass sales endpoint (GMV/traffic) CHƯA bắt được ở discovery 2026-06-05 (chart load lazy
// sau captcha) → test bằng fixture tổng hợp, giữ contract cho khi map được endpoint thật.
describe("extractCompassOverview (synthetic — sales endpoint chưa map)", () => {
  it("bóc gmv/orders/conversion khi có data", () => {
    const caps: Capture[] = [
      {
        url: "https://seller-us.tiktok.com/bff/compass/overview",
        status: 200,
        body: { data: { overview: { gmv: { amount: "1234.5" }, order_cnt: 42, conversion_rate: "2.3%" } } },
      },
    ];
    const m = extractCompassOverview(caps);
    expect(m.find((x) => x.key === "gmv")?.valueNum).toBe(1234.5);
    expect(m.find((x) => x.key === "orders")?.valueNum).toBe(42);
    expect(m.find((x) => x.key === "conversion_rate")?.valueNum).toBe(2.3);
  });
});
