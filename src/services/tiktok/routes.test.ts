import { describe, it, expect } from "vitest";
import { ROUTES } from "./routes";

describe("ROUTES", () => {
  it("v1 gồm homepage + compass-overview, mỗi route có extractor", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(keys).toContain("homepage");
    expect(keys).toContain("compass-overview");
    for (const r of ROUTES) {
      expect(typeof r.extractor).toBe("function");
      expect(r.url).toMatch(/^https:\/\/seller-us\.tiktok\.com\//);
    }
  });
});
