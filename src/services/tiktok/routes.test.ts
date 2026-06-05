import { describe, it, expect } from "vitest";
import { ROUTES } from "./routes";

describe("ROUTES", () => {
  it("v1 cào homepage, mỗi route có extractor + url seller hợp lệ", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(keys).toContain("homepage");
    for (const r of ROUTES) {
      expect(typeof r.extractor).toBe("function");
      expect(r.url).toMatch(/^https:\/\/seller-us\.tiktok\.com\//);
    }
  });

  it("compass-overview đã gỡ khỏi crawl hằng ngày (phase 2)", () => {
    expect(ROUTES.map((r) => r.key)).not.toContain("compass-overview");
  });
});
