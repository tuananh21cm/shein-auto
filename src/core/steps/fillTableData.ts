import { computeFinalPrice } from "../../config/appConfig";
import { generateRandomString } from "./randomUtils";

export interface PriceOverride {
  shipFee: number;
  multiplier: number;
  extraAdd: number;
}

/**
 * Lấy tên variant của 1 row = ô <td> ĐẦU TIÊN có chữ. Bỏ qua cột checkbox dẫn
 * đầu (rỗng) mà 4Seller mới thêm vào, nên không phụ thuộc vị trí cột cố định.
 */
const getVariantText = async (row: any): Promise<string> => {
  const tds = row.locator("td");
  const n = await tds.count();
  for (let j = 0; j < n; j++) {
    const t = (await tds.nth(j).innerText()).trim();
    if (t) return t;
  }
  return "";
};

/**
 * Điền price/SKU/qty cho từng variant trong bảng. Scroll-and-scan vì 4Seller
 * dùng virtual list nên không phải row nào cũng có sẵn trong DOM.
 *
 * @param priceOverride  Nếu pass, dùng công thức theo user override. Nếu null,
 *                       fallback global pricing.json qua computeFinalPrice.
 */
export const fillTableData = async (
  page: any,
  priceData: any[],
  skuValue: string = "TA-P5",
  qtyValue: number = 5,
  variantIds?: Array<{ [color: string]: string }>,
  priceOverride?: PriceOverride
): Promise<void> => {
  const calcPrice = (numericPrice: number): number => {
    if (priceOverride) {
      return (numericPrice + priceOverride.shipFee) * priceOverride.multiplier + priceOverride.extraAdd;
    }
    return computeFinalPrice(numericPrice);
  };
  console.log("--- Bắt đầu điền dữ liệu bảng (Price, SKU, Qty) ---");

  const rawPricing: { [key: string]: string } = Object.assign({}, ...priceData);
  const pricing: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(rawPricing)) {
    pricing[k.toLowerCase().trim()] = v;
  }

  const variantIdMap: { [key: string]: string } = {};
  if (variantIds) {
    for (const item of variantIds) {
      for (const [k, v] of Object.entries(item)) {
        variantIdMap[k.toLowerCase().trim()] = v;
      }
    }
  }
  // Giá fallback: dùng khi 1 màu không khớp key giá, để KHÔNG bỏ trống ô Retail Price
  // (ô trống sẽ chặn publish với "Can not be empty"). Các màu cùng sản phẩm
  // thường cùng giá nên đây là xấp xỉ an toàn hơn là để trống.
  const fallbackRaw = (() => {
    for (const v of Object.values(pricing)) {
      const n = parseFloat(v.toString().replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!isNaN(n)) return n;
    }
    return NaN;
  })();

  const ROW_SELECTOR = "table.custom_draft_table tbody tr.custom_draft_table_body_tr";
  const processedVariants = new Set<string>();

  // Điền 1 row (price/SKU/qty). Tách hàm để bọc try/catch khi row bị virtual-list
  // recycle giữa chừng — lượt sau sẽ xử lý lại.
  const fillOneRow = async (row: any, variantText: string): Promise<void> => {
    await row.evaluate((el: HTMLElement) =>
      el.scrollIntoView({ block: "center", inline: "nearest" })
    );
    await page.waitForTimeout(120);
    // Input theo THỨ TỰ trong row (bỏ qua cột checkbox + Variant): [0]=SKU, [1]=QTY, [2]=Price.
    const rowInputs = row.locator("td input.el-input__inner");
    const colorKey = variantText.split("/")[0].toLowerCase().trim();
    const priceToFill = pricing[colorKey];

    let numericPrice =
      priceToFill !== undefined
        ? parseFloat(priceToFill.toString().replace(",", ".").replace(/[^0-9.]/g, ""))
        : NaN;
    if (isNaN(numericPrice)) {
      if (!isNaN(fallbackRaw)) {
        console.warn(`⚠️ Màu "${colorKey}" không có giá khớp — dùng giá fallback ${fallbackRaw}.`);
        numericPrice = fallbackRaw;
      } else {
        console.warn(`⚠️ Màu "${colorKey}" không có giá và KHÔNG có fallback — ô Retail Price sẽ trống!`);
      }
    }
    if (!isNaN(numericPrice)) {
      const finalPrice = calcPrice(numericPrice);
      await rowInputs.nth(2).fill(finalPrice.toFixed(2));
      console.log(`✅ finalPrice (${variantText}): ${finalPrice.toFixed(2)}`);
    }

    const skuToFill =
      variantIdMap[colorKey] ?? (skuValue === "TA-P5" ? generateRandomString() : skuValue);
    await rowInputs.nth(0).fill(skuToFill);
    await rowInputs.nth(1).fill(qtyValue.toString());
  };

  // Vòng lặp STAGNATION: re-fetch rows mỗi lượt, điền các row chưa xử lý, cuộn xuống.
  // CHỈ dừng khi nhiều lượt liên tiếp không điền thêm row mới (đã quét hết bảng) —
  // tránh thoát sớm khi PageDown nhảy thẳng xuống cuối làm bỏ sót row giữa.
  let stagnant = 0;
  let passes = 0;
  const MAX_PASSES = 200; // backstop chống loop vô hạn
  while (stagnant < 3 && passes < MAX_PASSES) {
    passes++;
    const rows = page.locator(ROW_SELECTOR);
    const count = await rows.count();
    let newlyFilled = 0;

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      let variantText = "";
      try {
        variantText = await getVariantText(row);
      } catch {
        continue; // row bị recycle khi đọc → bỏ qua, lượt sau xử lý
      }
      if (!variantText || processedVariants.has(variantText)) continue;

      try {
        await fillOneRow(row, variantText);
        processedVariants.add(variantText);
        newlyFilled++;
      } catch (e: any) {
        // Row detach giữa chừng do scroll re-layout → không add vào processed,
        // lượt sau locator mới sẽ điền lại.
        console.warn(`⚠️ Row "${variantText}" điền lỗi (sẽ thử lại lượt sau): ${e?.message ?? e}`);
      }
    }

    await page.keyboard.press("PageDown");
    await page.waitForTimeout(500);
    stagnant = newlyFilled > 0 ? 0 : stagnant + 1;
  }

  console.log(`📊 fillTableData: đã điền ${processedVariants.size} variant (passes=${passes}).`);
};
