import { describe, it, expect } from "vitest";
import { isLoginWall } from "./crawlTiktokSeller";

describe("isLoginWall", () => {
  it("phát hiện redirect về trang login", () => {
    expect(isLoginWall("https://seller-us.tiktok.com/account/login?redirect=/homepage")).toBe(true);
    expect(isLoginWall("https://seller-us.tiktok.com/login")).toBe(true);
  });
  it("trang bình thường không phải login wall", () => {
    expect(isLoginWall("https://seller-us.tiktok.com/homepage")).toBe(false);
  });
});
