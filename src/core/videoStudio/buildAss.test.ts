import { describe, it, expect } from "vitest";
import { buildAss, groupWords, msToAssTime } from "./buildAss";
import type { TtsWord } from "../../services/tts/estimateWords";

const words: TtsWord[] = [
  { text: "Stop", startMs: 0, endMs: 300 },
  { text: "scrolling", startMs: 300, endMs: 800 },
  { text: "this", startMs: 900, endMs: 1100 },
  { text: "dress", startMs: 1100, endMs: 1500 },
  { text: "is", startMs: 1500, endMs: 1600 },
  { text: "everything", startMs: 1600, endMs: 2300 },
];

describe("msToAssTime", () => {
  it("format H:MM:SS.CC", () => {
    expect(msToAssTime(0)).toBe("0:00:00.00");
    expect(msToAssTime(61230)).toBe("0:01:01.23");
    expect(msToAssTime(3600000)).toBe("1:00:00.00");
  });
});

describe("groupWords", () => {
  it("nhóm 2-4 từ, thời gian nối tiếp không chồng lấn", () => {
    const lines = groupWords(words, "seed1");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      const n = l.text.split(" ").length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
      expect(l.endMs).toBeGreaterThan(l.startMs);
    }
    for (let i = 1; i < lines.length; i++) expect(lines[i].startMs).toBeGreaterThanOrEqual(lines[i - 1].endMs);
    // ghép lại đủ mọi từ
    expect(lines.map((l) => l.text).join(" ")).toBe(words.map((w) => w.text).join(" "));
  });

  it("cùng seed cho cùng kết quả", () => {
    expect(groupWords(words, "s")).toEqual(groupWords(words, "s"));
  });
});

describe("buildAss", () => {
  it("sinh file ASS hợp lệ: header, style, hook đầu, cta cuối, caption theo timestamps", () => {
    const ass = buildAss({ words, hook: "STOP SCROLLING", cta: "Tap the cart now!", totalMs: 10000, seed: "v1" });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Caption,");
    expect(ass).toContain("Style: Hook,");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("STOP SCROLLING");
    expect(ass).toContain("Tap the cart now!");
    // caption đầu tiên bắt đầu 0:00:00.00
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,.*Caption/);
    // CTA nằm trong 3s cuối
    expect(ass).toContain(`,${msToAssTime(10000)},`);
  });

  it("escape ký tự đặc biệt ASS trong text ({, }, \\n)", () => {
    const ass = buildAss({
      words: [{ text: "50%", startMs: 0, endMs: 500 }],
      hook: "Deal {today}", cta: "Now\\here", totalMs: 3000, seed: "x",
    });
    expect(ass).not.toContain("{today}");   // { } phải bị escape/loại
  });
});
