import { describe, it, expect } from "vitest";
import { toTitleCase } from "./cleanTitle";

describe("toTitleCase", () => {
  it("viết hoa chữ đầu mỗi từ", () => {
    expect(toTitleCase("summer floral maxi dress")).toBe("Summer Floral Maxi Dress");
  });
  it("giữ nguyên acronym/chữ đã hoa (USA, 3D)", () => {
    expect(toTitleCase("USA flag tee 3D print")).toBe("USA Flag Tee 3D Print");
  });
  it("hoa sau dấu - / _ &", () => {
    expect(toTitleCase("v-neck long-sleeve top")).toBe("V-Neck Long-Sleeve Top");
    expect(toTitleCase("bra & panty set")).toBe("Bra & Panty Set");
  });
  it("gộp khoảng trắng thừa + trim", () => {
    expect(toTitleCase("  women   cami  top ")).toBe("Women Cami Top");
  });
  it("giữ apostrophe", () => {
    expect(toTitleCase("women's wireless bralette")).toBe("Women's Wireless Bralette");
  });
  it("rỗng → rỗng", () => {
    expect(toTitleCase("")).toBe("");
  });
});
