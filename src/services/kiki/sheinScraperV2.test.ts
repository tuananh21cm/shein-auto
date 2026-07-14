import { describe, it, expect } from "vitest";
import { parseRealtime } from "./sheinScraperV2";

/** Payload rút gọn theo đúng shape BFF get_goods_detail_realtime_data (capture 2026-07-11). */
const info = {
  productInfo: { goods_id: "331343286", goods_sn: "sz25052228829933483" },
  priceInfo: {
    salePrice: { amount: "4.09", amountWithSymbol: "$4.09" },
    retailPrice: { amount: "6.09", amountWithSymbol: "$6.09" },
  },
  saleAttr: {
    multiLevelSaleAttribute: {
      skc_sale_attr: [{ attr_name: "Size", attr_value_list: [{ attr_value_name: "XS" }, { attr_value_name: "S" }] }],
      sku_list: [
        { sku_code: "I1", sku_sale_attr: [{ attr_name: "Size", attr_value_name: "M" }], stock: "20" },
        { sku_code: "I2", sku_sale_attr: [{ attr_name: "Size", attr_value_name: "XS" }], stock: "20" },
        { sku_code: "I3", sku_sale_attr: [{ attr_name: "Size", attr_value_name: "S" }], stock: "0" }, // hết hàng
        { sku_code: "I4", sku_sale_attr: [{ attr_name: "Color", attr_value_name: "Black" }], stock: "5" }, // không phải Size → bỏ
      ],
    },
  },
};

describe("parseRealtime — size/tồn/giá từ BFF JSON", () => {
  it("bóc goods_id, giá, và tồn kho TỪNG size", () => {
    const r = parseRealtime(info);
    expect(r.goodsId).toBe("331343286");
    expect(r.salePrice).toBe("4.09");
    expect(r.retailPrice).toBe("6.09");
    expect(r.sizeStock).toEqual({ M: 20, XS: 20, S: 0 }); // S hết hàng → stock 0, vẫn ghi nhận
  });

  it("bỏ sku không phải thuộc tính Size", () => {
    const r = parseRealtime(info);
    expect(Object.keys(r.sizeStock)).not.toContain("Black");
  });

  it("payload rỗng/hỏng → không vỡ", () => {
    expect(parseRealtime(null).sizeStock).toEqual({});
    expect(parseRealtime({}).goodsId).toBeNull();
    expect(parseRealtime({ saleAttr: {} }).salePrice).toBeNull();
  });
});
