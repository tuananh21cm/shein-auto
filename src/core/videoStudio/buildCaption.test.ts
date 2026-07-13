import { describe, it, expect } from "vitest";
import { buildCaption, buildHashtags } from "./buildCaption";

describe("buildHashtags", () => {
  it("suy hashtag theo ngành hàng từ title + tag chung, tối đa 6, không trùng", () => {
    const tags = buildHashtags("RUTMAN Halter tie bikini set sexy contrast color", "s1");
    expect(tags.length).toBeGreaterThanOrEqual(4);
    expect(tags.length).toBeLessThanOrEqual(6);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.some((t) => /bikini|swim|beach|summerbody/.test(t))).toBe(true);
    for (const t of tags) expect(t.startsWith("#")).toBe(true);
  });

  it("cùng seed → cùng hashtag (ổn định, không churn khi retry)", () => {
    expect(buildHashtags("Summer dress", "x")).toEqual(buildHashtags("Summer dress", "x"));
  });

  it("dùng hashtag từ script nếu có, tự thêm '#' còn thiếu", () => {
    const tags = buildHashtags("Dress", "s", ["summervibes", "#datenight"]);
    expect(tags).toContain("#summervibes");
    expect(tags).toContain("#datenight");
  });
});

describe("buildCaption", () => {
  it("ghép hook + cta + hashtags", () => {
    const cap = buildCaption({
      title: "RUTMAN Bikini set floral",
      seed: "s",
      script: { hook: "Wait till you see the back", cta: "Tap the cart now!" },
    });
    expect(cap).toContain("Wait till you see the back");
    expect(cap).toContain("Tap the cart now!");
    expect(cap).toMatch(/#\w+/);
    expect(cap.length).toBeLessThanOrEqual(2200);
  });

  it("không có script → dùng title làm câu mở, vẫn có hashtag", () => {
    const cap = buildCaption({ title: "RUTMAN Bikini set floral print", seed: "s", script: null });
    expect(cap).toContain("Bikini set floral print");
    expect(cap).toMatch(/#\w+/);
  });
});
