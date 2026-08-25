import { describe, it, expect } from "vitest";
import { extractImageUrls } from "./fetchImages";

describe("extractImageUrls", () => {
  it("detail.images là mảng string", () => {
    expect(extractImageUrls({ images: ["http://a/1.jpg", "http://a/2.jpg"] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images là mảng object {url} hoặc {imgUrl}", () => {
    expect(extractImageUrls({ images: [{ url: "http://a/1.jpg" }, { imgUrl: "http://a/2.jpg" }] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images là chuỗi phân cách '|'", () => {
    expect(extractImageUrls({ images: "http://a/1.jpg|http://a/2.jpg" }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("fallback mainImage khi detail không có ảnh; dedup; bỏ chuỗi rỗng", () => {
    expect(extractImageUrls({}, "http://a/1.jpg|http://a/1.jpg||http://a/2.jpg"))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("không có gì → mảng rỗng", () => {
    expect(extractImageUrls(null, undefined)).toEqual([]);
  });
});
