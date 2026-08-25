import { describe, it, expect } from "vitest";
import { deepFind, deepFindFirst, toNum } from "./deepFind";

describe("deepFind", () => {
  it("tìm key lồng sâu", () => {
    const o = { a: { b: { gmv: 1234 } } };
    expect(deepFind(o, "gmv")).toBe(1234);
  });
  it("trả undefined khi không thấy", () => {
    expect(deepFind({ a: 1 }, "nope")).toBeUndefined();
  });
});

describe("deepFindFirst", () => {
  it("lấy key đầu tiên khớp trong danh sách ứng viên", () => {
    const o = { stats: { order_cnt: 50 } };
    expect(deepFindFirst(o, ["orders", "order_count", "order_cnt"])).toBe(50);
  });
});

describe("toNum", () => {
  it("parse số có ký tự tiền tệ/phẩy", () => {
    expect(toNum("$1,234.5")).toBe(1234.5);
  });
  it("parse phần trăm", () => {
    expect(toNum("12.3%")).toBe(12.3);
  });
  it("trả null cho rác", () => {
    expect(toNum("N/A")).toBeNull();
  });
  it("nhận object {amount}", () => {
    expect(toNum({ amount: "9.99" })).toBe(9.99);
  });
});
