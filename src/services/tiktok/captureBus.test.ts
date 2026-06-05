import { describe, it, expect } from "vitest";
import { isSellerJson } from "./captureBus";

describe("isSellerJson", () => {
  it("giữ JSON từ API seller-us", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/api/v1/homepage/data", "application/json")).toBe(true);
  });
  it("giữ JSON từ BFF host", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/bff/compass/overview", "application/json; charset=utf-8")).toBe(true);
  });
  it("bỏ asset không phải json", () => {
    expect(isSellerJson("https://seller-us.tiktok.com/static/app.js", "application/javascript")).toBe(false);
  });
  it("bỏ host ngoài", () => {
    expect(isSellerJson("https://www.google-analytics.com/collect", "application/json")).toBe(false);
  });
});
