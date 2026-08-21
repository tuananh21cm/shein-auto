import { describe, it, expect } from "vitest";
import { fixInflatedVariantPrices } from "./fixVariantPrices";

describe("fixInflatedVariantPrices", () => {
  it("chia giá bị thổi x3/x4 về sát baseline, giữ giá thường", () => {
    const vp = [{ Red: "10" }, { Blue: "10.5" }, { Green: "30" }, { Black: "40" }];
    const { fixed, baseline } = fixInflatedVariantPrices(vp, {});
    expect(baseline).toBe(10);
    expect(fixed).toBe(2);
    expect(vp[2].Green).toBe("10"); // 30 ÷3
    expect(vp[3].Black).toBe("10"); // 40 ÷4
    expect(vp[0].Red).toBe("10");   // giữ nguyên
  });

  it("không đụng khi mọi giá gần nhau (không có thổi giá)", () => {
    const vp = [{ A: "12" }, { B: "13" }, { C: "12.5" }];
    const { fixed } = fixInflatedVariantPrices(vp, {});
    expect(fixed).toBe(0);
  });

  it("giữ number type + bỏ qua khi < 3 variant", () => {
    const vp = [{ A: 10 }, { B: 10 }, { C: 30 }];
    fixInflatedVariantPrices(vp, {});
    expect(vp[2].C).toBe(10);
    expect(typeof vp[2].C).toBe("number");
    expect(fixInflatedVariantPrices([{ A: "10" }, { B: "30" }], {}).fixed).toBe(0);
  });
});
