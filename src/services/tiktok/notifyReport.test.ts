import { describe, it, expect } from "vitest";
import { chunkText } from "./notifyReport";

describe("chunkText", () => {
  it("text ngắn → 1 đoạn", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });
  it("tách theo dòng, mỗi đoạn <= maxLen", () => {
    const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
    const chunks = chunkText(text, 10); // mỗi đoạn ~2 dòng
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.join("\n")).toBe(text);
  });
  it("cắt cứng dòng dài hơn maxLen", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe("x".repeat(25));
  });
});
