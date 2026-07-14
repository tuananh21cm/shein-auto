import { describe, it, expect } from "vitest";
import { isPackProduct } from "./fashionFilter";

describe("isPackProduct — loại hàng pack (2+ món giống nhau)", () => {
  it("BẮT pack: 2-9pcs, /Set, /Pack, N-Pack", () => {
    for (const n of [
      "SHEIN EZwear 3pcs/Set Casual Adjustable Strap Fitted Tank Top",
      "SHEIN EZwear 3pcs Women Casual Solid Color Camisoles",
      "SHEIN BASICS 3pcs/Pack Casual Solid Color Knit Fitted Cropped Tank",
      "SHEIN EZwear 4pcs Women's Tight Fitted Cropped Casual Tank Tops",
      "2 Pack Panties Cotton", "3-Pack Socks", "5pcs Hair Ties", "Pack of 3 Bras", "Set of 4 Cami",
    ]) expect(isPackProduct(n)).toBe(true);
  });

  it("GIỮ: 1 món, và 'X Piece Set' (set phối đồ, không phải pack)", () => {
    for (const n of [
      "INAWLY 1pc Women Lace Trim Camisole Top",
      "2 Piece Bikini Set Halter", "3 Piece Lingerie Set Floral", "Two Piece Set Crop Top",
      "SHEIN BAE Solid Crop Cami Top", "Cami Tank Top Women", "Bodycon Mini Dress",
    ]) expect(isPackProduct(n)).toBe(false);
  });

  it("rỗng/null → false", () => {
    expect(isPackProduct("")).toBe(false);
    expect(isPackProduct(null)).toBe(false);
  });
});
