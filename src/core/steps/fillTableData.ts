import { computeFinalPrice } from "../../config/appConfig";
import { generateRandomString } from "./randomUtils";

/**
 * Điền price/SKU/qty cho từng variant trong bảng. Scroll-and-scan vì 4Seller
 * dùng virtual list nên không phải row nào cũng có sẵn trong DOM.
 */
export const fillTableData = async (
  page: any,
  priceData: any[],
  skuValue: string = "TA-P5",
  qtyValue: number = 5,
  variantIds?: Array<{ [color: string]: string }>
): Promise<void> => {
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
  const processedVariants = new Set();
  let isEnd = false;

  while (!isEnd) {
    const currentVisibleRows = page.locator(
      "table.custom_draft_table tbody tr.custom_draft_table_body_tr"
    );
    const count = await currentVisibleRows.count();

    for (let i = 0; i < count; i++) {
      const row = currentVisibleRows.nth(i);
      const variantText = await row.locator("td").first().innerText();

      if (!processedVariants.has(variantText)) {
        await row.scrollIntoViewIfNeeded();
        const colorKey = variantText.split("/")[0].toLowerCase().trim();
        const priceToFill = pricing[colorKey];

        if (priceToFill !== undefined) {
          // Chuyển dấu phẩy thành dấu chấm rồi clean ký tự lạ (€, $)
          let cleanPrice = priceToFill.toString().replace(",", ".");
          cleanPrice = cleanPrice.replace(/[^0-9.]/g, "");
          const numericPrice = parseFloat(cleanPrice);

          if (!isNaN(numericPrice)) {
            const finalPrice = computeFinalPrice(numericPrice);
            const priceInput = row.locator("td").nth(3).locator("input.el-input__inner");
            await priceInput.fill(finalPrice.toFixed(2));
            console.log(`✅ finalPrice: ${finalPrice.toFixed(2)}`);
          }
        }

        const skuInput = row.locator("td").nth(1).locator("input.el-input__inner");
        const skuToFill =
          variantIdMap[colorKey] ?? (skuValue === "TA-P5" ? generateRandomString() : skuValue);
        await skuInput.fill(skuToFill);

        const qtyInput = row.locator("td").nth(2).locator("input.el-input__inner");
        await qtyInput.fill(qtyValue.toString());

        processedVariants.add(variantText);
      }
    }

    await page.keyboard.press("PageDown");
    await page.waitForTimeout(600);

    const checkAgain = page.locator("table.custom_draft_table tbody tr.custom_draft_table_body_tr");
    const lastRowText = await checkAgain.last().locator("td").first().innerText();
    if (processedVariants.has(lastRowText)) isEnd = true;
  }
};
