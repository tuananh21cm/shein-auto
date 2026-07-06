import { computeFinalPrice } from "../../config/appConfig";
import { generateRandomString } from "./randomUtils";

export interface PriceOverride {
  shipFee: number;
  multiplier: number;
  extraAdd: number;
}

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
  priceOverride?: PriceOverride,
  shopSuffix: string = "",
  /** Phụ giá theo SIZE (POD): { "XXL": 2, "3XL": 4 } → cộng vào giá đi đơn của size đó. */
  sizeSurcharge?: Record<string, number>
): Promise<void> => {
  const calcPrice = (numericPrice: number): number => {
    if (priceOverride) {
      return (numericPrice + priceOverride.shipFee) * priceOverride.multiplier + priceOverride.extraAdd;
    }
    return computeFinalPrice(numericPrice);
  };
  // Lookup phụ giá theo size (chuẩn hoá lowercase, bỏ space). XXL≈2XL.
  const surchargeMap: Record<string, number> = {};
  if (sizeSurcharge) {
    for (const [k, v] of Object.entries(sizeSurcharge)) {
      const key = k.toLowerCase().replace(/\s+/g, "");
      const n = Number(v);
      if (key && !isNaN(n)) {
        surchargeMap[key] = n;
        if (key === "xxl") surchargeMap["2xl"] = n; // đồng nghĩa
        if (key === "2xl") surchargeMap["xxl"] = n;
      }
    }
  }
  const surchargeFor = (sizeText: string): number => {
    const key = (sizeText || "").toLowerCase().replace(/\s+/g, "");
    return surchargeMap[key] ?? 0;
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
  const processedVariants = new Set();
  // Variant không match được giá (lookup miss / giá NaN) → ô Retail Price bị bỏ trống
  // → publish fail "Can not be empty". Gom lại để throw rõ ràng thay vì skip im lặng.
  const missingPriceVariants: string[] = [];
  let isEnd = false;

  // 4Seller có thể CHÈN cột checkbox đầu bảng → index td lệch. Xác định cột theo HEADER
  // (Variant / Shop-stock SKU / QTY / Retail Price) thay vì index cứng → bền với thay đổi UI.
  let variantCol = 0;
  let skuCol = 1;
  let qtyCol = 2;
  let priceCol = 3;
  try {
    const headerCells = page.locator("table.custom_draft_table thead tr").first().locator("th, td");
    const hCount = await headerCells.count();
    let vc = -1,
      sc = -1,
      qc = -1,
      pc = -1;
    for (let h = 0; h < hCount; h++) {
      const t = (await headerCells.nth(h).innerText().catch(() => "")).toLowerCase();
      if (vc < 0 && /variant/.test(t)) vc = h;
      else if (sc < 0 && /sku|stock/.test(t)) sc = h;
      else if (qc < 0 && /qty|quantity/.test(t)) qc = h;
      else if (pc < 0 && /price/.test(t)) pc = h;
    }
    if (vc >= 0 && sc >= 0 && qc >= 0 && pc >= 0) {
      variantCol = vc;
      skuCol = sc;
      qtyCol = qc;
      priceCol = pc;
    }
  } catch {
    /* giữ index mặc định 0/1/2/3 */
  }
  console.log(`Cột bảng (theo header): variant=${variantCol}, sku=${skuCol}, qty=${qtyCol}, price=${priceCol}`);

  while (!isEnd) {
    const currentVisibleRows = page.locator(
      "table.custom_draft_table tbody tr.custom_draft_table_body_tr"
    );
    const count = await currentVisibleRows.count();

    for (let i = 0; i < count; i++) {
      const row = currentVisibleRows.nth(i);
      const variantText = await row.locator("td").nth(variantCol).innerText();

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
            // Size = phần sau dấu "/" đầu tiên (POD: "Black/XXL" → "XXL"). Cộng phụ giá nếu có.
            const sizeText = variantText.includes("/") ? variantText.slice(variantText.indexOf("/") + 1).trim() : "";
            const surcharge = surchargeFor(sizeText);
            const finalPrice = calcPrice(numericPrice) + surcharge;
            const priceInput = row.locator("td").nth(priceCol).locator("input").first();
            await priceInput.fill(finalPrice.toFixed(2));
            console.log(`✅ finalPrice: ${finalPrice.toFixed(2)}${surcharge ? ` (size ${sizeText} +$${surcharge})` : ""}`);
          } else {
            missingPriceVariants.push(`${variantText} (giá không parse được: "${priceToFill}")`);
          }
        } else {
          missingPriceVariants.push(`${variantText} (không có key "${colorKey}" trong variant_price)`);
        }

        const skuInput = row.locator("td").nth(skuCol).locator("input").first();
        const baseSku =
          variantIdMap[colorKey] ?? (skuValue === "TA-P5" ? generateRandomString() : skuValue);
        // Ghép tên shop vào SKU: "455717797-MemeteeShop"
        const skuToFill = shopSuffix ? `${baseSku}-${shopSuffix}` : baseSku;
        await skuInput.fill(skuToFill);

        const qtyInput = row.locator("td").nth(qtyCol).locator("input").first();
        // Stock RANDOM 5–10 mỗi variant (tránh pattern "toàn 5" bị TikTok đánh spam).
        const qty = qtyValue + Math.floor(Math.random() * 6); // qtyValue(5)..+5 = 5..10
        await qtyInput.fill(qty.toString());

        processedVariants.add(variantText);
      }
    }

    await page.keyboard.press("PageDown");
    await page.waitForTimeout(600);

    const checkAgain = page.locator("table.custom_draft_table tbody tr.custom_draft_table_body_tr");
    const lastRowText = await checkAgain.last().locator("td").nth(variantCol).innerText();
    if (processedVariants.has(lastRowText)) isEnd = true;
  }

  if (missingPriceVariants.length > 0) {
    throw new Error(
      `fillTableData: ${missingPriceVariants.length}/${processedVariants.size} variant không điền được giá — ` +
        `Retail Price trống sẽ fail publish "Can not be empty". Chi tiết: ${missingPriceVariants.join("; ")}`
    );
  }
};
