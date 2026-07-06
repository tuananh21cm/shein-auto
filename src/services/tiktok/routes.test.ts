import { describe, it, expect } from "vitest";
import { ROUTES, paginateProductManage } from "./routes";
import type { Capture } from "./types";

describe("ROUTES", () => {
  it("v1 cào homepage, mỗi route có extractor + url seller hợp lệ", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(keys).toContain("homepage");
    for (const r of ROUTES) {
      expect(typeof r.extractor).toBe("function");
      expect(r.url).toMatch(/^https:\/\/seller-us\.tiktok\.com\//);
    }
  });

  it("compass-overview đã gỡ khỏi crawl hằng ngày (phase 2)", () => {
    expect(ROUTES.map((r) => r.key)).not.toContain("compass-overview");
  });

  it("product-manage có interact (paginate trang 2) + listingExtractor", () => {
    const pm = ROUTES.find((r) => r.key === "product-manage")!;
    expect(typeof pm.interact).toBe("function");
    expect(typeof pm.listingExtractor).toBe("function");
  });
});

describe("paginateProductManage", () => {
  const listCap = (page: number, total: number): Capture => ({
    url: `https://seller-us.tiktok.com/api/v1/product/local/products/list?page_number=${page}`,
    status: 200,
    body: { data: { total_product_count: total, products: [] } },
  });

  /** Fake Playwright page: locator luôn thấy nút; click → onClick(). */
  function fakePage(onClick: () => void) {
    const clicks: string[] = [];
    return {
      clicks,
      mouse: { wheel: async () => {} },
      waitForTimeout: async () => {},
      locator(sel: string) {
        return {
          first() { return this; },
          count: async () => 1,
          scrollIntoViewIfNeeded: async () => {},
          click: async () => { clicks.push(sel); onClick(); },
        };
      },
    };
  }

  it("shop ≤50 SP → không click", async () => {
    const buffer = [listCap(1, 42)];
    const page = fakePage(() => buffer.push(listCap(2, 42)));
    await paginateProductManage(page, { snapshot: () => buffer.slice() }, () => {});
    expect(page.clicks).toEqual([]);
    expect(buffer.length).toBe(1);
  });

  it("shop >50 SP → click trang 2 và chờ capture mới về", async () => {
    const buffer = [listCap(1, 100)];
    const logs: string[] = [];
    const page = fakePage(() => buffer.push(listCap(2, 100)));
    await paginateProductManage(page, { snapshot: () => buffer.slice() }, (m) => logs.push(m));
    expect(page.clicks.length).toBe(1);
    // selector ưu tiên = DOM thật của Seller Center (core-pagination + aria-label)
    expect(page.clicks[0]).toBe('li.core-pagination-item[aria-label="Page 2"]');
    expect(buffer.length).toBe(2);
    expect(logs.join("\n")).toContain("trang 2 đã về");
  });

  it("không thấy nút trang 2 → cảnh báo, không throw", async () => {
    const buffer = [listCap(1, 100)];
    const logs: string[] = [];
    const page = {
      mouse: { wheel: async () => {} },
      waitForTimeout: async () => {},
      locator: () => ({ first() { return this; }, count: async () => 0 }),
    };
    await paginateProductManage(page, { snapshot: () => buffer.slice() }, (m) => logs.push(m));
    expect(logs.join("\n")).toContain("không thấy nút trang 2");
  });

  it("chưa có capture products/list (route fail trước đó) → thoát êm", async () => {
    const page = fakePage(() => {});
    await paginateProductManage(page, { snapshot: () => [] }, () => {});
    expect(page.clicks).toEqual([]);
  });
});
