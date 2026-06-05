import { describe, it, expect } from "vitest";
import { extractHomepage } from "./homepage";
import { extractCompassOverview } from "./compassOverview";
import type { Capture } from "../types";

describe("extractHomepage", () => {
  it("bóc số alert + đơn chờ xử lý", () => {
    const caps: Capture[] = [
      { url: "https://seller-us.tiktok.com/api/homepage/todo", status: 200, body: {
        data: { to_do_list: { pending_orders: 7, alert_count: 3 } } } },
    ];
    const m = extractHomepage(caps);
    expect(m.find((x) => x.key === "pending_orders")?.valueNum).toBe(7);
    expect(m.find((x) => x.key === "alert_count")?.valueNum).toBe(3);
  });

  it("không vỡ khi captures rỗng", () => {
    expect(extractHomepage([])).toEqual([]);
  });
});

describe("extractCompassOverview", () => {
  it("bóc gmv/orders/conversion", () => {
    const caps: Capture[] = [
      { url: "https://seller-us.tiktok.com/bff/compass/overview", status: 200, body: {
        data: { overview: { gmv: { amount: "1234.5" }, order_cnt: 42, conversion_rate: "2.3%" } } } },
    ];
    const m = extractCompassOverview(caps);
    expect(m.find((x) => x.key === "gmv")?.valueNum).toBe(1234.5);
    expect(m.find((x) => x.key === "orders")?.valueNum).toBe(42);
    expect(m.find((x) => x.key === "conversion_rate")?.valueNum).toBe(2.3);
  });
});
