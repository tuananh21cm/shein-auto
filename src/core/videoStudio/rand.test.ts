import { describe, it, expect } from "vitest";
import { seededRng, seededPick, seededShuffle } from "./rand";

describe("seededRng", () => {
  it("cùng seed → cùng chuỗi số, khác seed → khác", () => {
    const a1 = seededRng("abc"), a2 = seededRng("abc"), b = seededRng("xyz");
    const s1 = [a1(), a1(), a1()], s2 = [a2(), a2(), a2()], s3 = [b(), b(), b()];
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    for (const v of s1) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("seededPick / seededShuffle", () => {
  it("pick trả phần tử thuộc mảng, shuffle giữ nguyên phần tử", () => {
    const rng = seededRng("s1");
    const arr = ["a", "b", "c", "d"];
    expect(arr).toContain(seededPick(rng, arr));
    const sh = seededShuffle(seededRng("s2"), arr);
    expect(sh).not.toBe(arr);           // không mutate mảng gốc
    expect([...sh].sort()).toEqual([...arr].sort());
  });
});
