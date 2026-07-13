import { describe, it, expect } from "vitest";
import { validateScript, scriptToText } from "./genVideoScript";

describe("validateScript", () => {
  it("chấp nhận script hợp lệ, trim khoảng trắng", () => {
    const s = validateScript({ hook: " Stop scrolling! ", lines: ["Line one.", "Line two."], cta: "Get yours now" });
    expect(s.hook).toBe("Stop scrolling!");
    expect(s.lines).toEqual(["Line one.", "Line two."]);
  });

  it("cắt bớt khi tổng > 110 từ (giữ hook + cta, bỏ lines cuối)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `sentence number ${i} has exactly six words`);
    const s = validateScript({ hook: "Hook here", lines: long, cta: "Buy now" });
    const totalWords = scriptToText(s).split(/\s+/).length;
    expect(totalWords).toBeLessThanOrEqual(110);
    expect(s.cta).toBe("Buy now");
  });

  it("throw khi thiếu hook hoặc lines rỗng", () => {
    expect(() => validateScript({ hook: "", lines: ["x"], cta: "y" })).toThrow();
    expect(() => validateScript({ hook: "h", lines: [], cta: "y" })).toThrow();
  });
});

describe("scriptToText", () => {
  it("nối hook + lines + cta thành 1 đoạn cho TTS", () => {
    expect(scriptToText({ hook: "A.", lines: ["B.", "C."], cta: "D." })).toBe("A. B. C. D.");
  });
});
