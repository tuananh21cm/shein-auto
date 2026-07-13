import { describe, it, expect } from "vitest";
import { estimateWordTimings } from "./estimateWords";

describe("estimateWordTimings", () => {
  it("chia duration theo trọng số độ dài từ, phủ kín 0→duration, không chồng lấn", () => {
    const words = estimateWordTimings("Hi this is a wonderful dress", 6000);
    expect(words.map((w) => w.text)).toEqual(["Hi", "this", "is", "a", "wonderful", "dress"]);
    expect(words[0].startMs).toBe(0);
    expect(words[words.length - 1].endMs).toBe(6000);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBe(words[i - 1].endMs);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
    }
    // từ dài hơn được nhiều thời gian hơn từ 1 ký tự
    const wonderful = words[4], a = words[3];
    expect(wonderful.endMs - wonderful.startMs).toBeGreaterThan(a.endMs - a.startMs);
  });

  it("text rỗng → mảng rỗng", () => {
    expect(estimateWordTimings("   ", 3000)).toEqual([]);
  });
});
