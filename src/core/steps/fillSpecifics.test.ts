import { describe, it, expect } from "vitest";
import { matchOption } from "./fillSpecifics";

describe("matchOption — thành phần có %", () => {
  const opts = ["Cotton", "Polyester", "Elastane", "Viscose", "Denim"];
  it("chọn thành phần % cao nhất, không chọn tên dài nhất (Elastane 1% → TikTok suspend)", () => {
    expect(matchOption("54% Cotton, 36% Polyester, 9% Viscose, 1% Elastane", opts, {})).toBe("Cotton");
    expect(matchOption("30% Cotton, 68% Polyester, 2% Elastane", opts, {})).toBe("Polyester");
  });
  it("thành phần chính không có trong option → bỏ trống, KHÔNG lùi xuống thành phần phụ", () => {
    expect(matchOption("94% Viscose, 6% Polyester", ["Recycled polyester blends", "Cotton"], {})).toBeNull();
  });
  it("giá trị đơn giữ nguyên hành vi cũ", () => {
    expect(matchOption("100% Polyester", opts, {})).toBe("Polyester");
    expect(matchOption("Denim", opts, {})).toBe("Denim");
  });
});
