import { describe, it, expect } from "vitest";
import { addTrendKeyword } from "./trendTitle";

describe("addTrendKeyword", () => {
  it("prefix: chèn keyword đầu title", () => {
    expect(addTrendKeyword("Floral Dress", "Back to School", "prefix")).toBe("Back to School Floral Dress");
  });

  it("suffix: chèn keyword cuối title", () => {
    expect(addTrendKeyword("Floral Dress", "Back to School", "suffix")).toBe("Floral Dress Back to School");
  });

  it("title đã chứa keyword (khác hoa/thường) → giữ nguyên, không lặp", () => {
    expect(addTrendKeyword("Back To School Backpack", "back to school", "prefix")).toBe("Back To School Backpack");
  });

  it("keyword rỗng → giữ nguyên title", () => {
    expect(addTrendKeyword("Floral Dress", "  ", "prefix")).toBe("Floral Dress");
  });

  it("title rỗng → trả rỗng (không chèn keyword mồ côi)", () => {
    expect(addTrendKeyword("", "Back to School", "prefix")).toBe("");
  });
});
