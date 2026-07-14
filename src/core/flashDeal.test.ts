import { describe, it, expect } from "vitest";
import { flashDealPrice } from "./flashDeal";

/** % hiển thị của TikTok = ceil(discount thực). Deal giá đúng phải cho ceil = pct. */
const displayedPct = (orig: number, deal: number) => Math.ceil((1 - deal / orig) * 100 - 1e-9);

describe("flashDealPrice — giá deal ceil để TikTok hiển thị đúng pct%", () => {
  it("ceil to cents, KHÔNG round-nearest (khớp 4Seller)", () => {
    expect(flashDealPrice(35.44, 24)).toBe("26.94"); // 26.9344 → ceil 26.94 (không phải 26.93)
    expect(flashDealPrice(31.74, 24)).toBe("24.13"); // 24.1224 → ceil 24.13 (không phải 24.12)
    expect(flashDealPrice(14.99, 24)).toBe("11.40"); // 11.3924 → ceil 11.40
  });

  it("mọi giá gốc thực → discount hiển thị = 24% (không lỡ thành 25%)", () => {
    const cases = [31.74, 35.44, 34.46, 58.85, 20.42, 14.99, 9.99, 12.85, 40.89, 3.75, 100.0, 7.13];
    for (const orig of cases) {
      const deal = Number(flashDealPrice(orig, 24));
      expect(deal).toBeGreaterThanOrEqual(orig * 0.76); // ceil → deal ≥ giá đúng → discount ≤ 24%
      expect(displayedPct(orig, deal)).toBe(24);         // TikTok hiển thị đúng 24%
    }
  });

  it("pct khác vẫn đúng", () => {
    expect(displayedPct(50, Number(flashDealPrice(50, 30)))).toBe(30);
    expect(displayedPct(19.99, Number(flashDealPrice(19.99, 15)))).toBe(15);
  });
});
