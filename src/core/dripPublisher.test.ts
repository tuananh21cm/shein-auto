import { describe, it, expect } from "vitest";
import { randMs } from "./dripPublisher";

describe("randMs", () => {
  it("nằm trong [min, max] phút", () => {
    for (let i = 0; i < 50; i++) {
      const ms = randMs(10, 15);
      expect(ms).toBeGreaterThanOrEqual(10 * 60_000);
      expect(ms).toBeLessThanOrEqual(15 * 60_000);
    }
  });
  it("min==max → đúng giá trị đó", () => {
    expect(randMs(12, 12)).toBe(12 * 60_000);
  });
});
