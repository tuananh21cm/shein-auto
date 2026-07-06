import { describe, it, expect } from "vitest";
import { isKidsProduct } from "./fashionFilter";

describe("isKidsProduct", () => {
  it("bắt hàng trẻ em theo tên", () => {
    expect(isKidsProduct("Girls Summer Floral Dress")).toBe(true);
    expect(isKidsProduct("Toddler Boys Graphic Tee")).toBe(true);
    expect(isKidsProduct("Kids Athletic Socks 3 Pack")).toBe(true);
    expect(isKidsProduct("Baby Romper 0-6 Months")).toBe(true);
    expect(isKidsProduct("Youth Hoodie")).toBe(true);
  });
  it("bắt theo category name", () => {
    expect(isKidsProduct("Cotton Tee", "Girls Clothing")).toBe(true);
    expect(isKidsProduct("Solid Leggings", "Kids")).toBe(true);
  });
  it("GIỮ hàng người lớn (whitelist)", () => {
    expect(isKidsProduct("Y2K Baby Tee Crop Top Women")).toBe(false);
    expect(isKidsProduct("Contrast Lace Babydoll Lingerie")).toBe(false);
    expect(isKidsProduct("Women's Seamless Boy Shorts Panties")).toBe(false);
    expect(isKidsProduct("Boyfriend Fit Denim Jeans")).toBe(false);
  });
  it("kids MẠNH ưu tiên hơn baby-tee (bug đã fix)", () => {
    expect(isKidsProduct("Toddler White T-Shirt Funny Cute Casual Kids Graphic Soft Baby Tee")).toBe(true);
    expect(isKidsProduct("Disney Printed T-Shirt For Toddlers Girly Style")).toBe(true);
    expect(isKidsProduct("SHEIN Tween Girls 3-Piece Bikini Set")).toBe(true);
    expect(isKidsProduct("Cotton Tee", "Home / Kids / Girls Clothing")).toBe(true);
  });
  it("KHÔNG bắt nhầm 'baby' người lớn (baby tee/blue/pink)", () => {
    expect(isKidsProduct("Womens Y2k Graphic Baby Tees Slim Fit Round Neck")).toBe(false);
    expect(isKidsProduct("Women's Crop Baby Tee Streetwear")).toBe(false);
    expect(isKidsProduct("Baby Blue Ruched Bodycon Dress")).toBe(false);
    expect(isKidsProduct("Baby Pink Lace Bralette")).toBe(false);
  });
  it("GIỮ thời trang nữ thường", () => {
    expect(isKidsProduct("Floral Lace Wireless Bralette Set")).toBe(false);
    expect(isKidsProduct("High Waist Shapewear Bodysuit")).toBe(false);
    expect(isKidsProduct("Ruched Crop Top Streetwear")).toBe(false);
  });
});
