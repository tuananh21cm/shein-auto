import { computeFinalPrice } from "../../config/appConfig";
import { generateRandomString } from "./randomUtils";

/** Giá vượt ngần này lần trung vị coi là nhiễu, không cho quyết định giá listing. */
const PRICE_OUTLIER_RATIO = 2;
/**
 * Tên variant gợi ý hàng bundle (2pcs / set / combo…). Bundle đắt là GIÁ THẬT nên được
 * MIỄN TRỪ khỏi bộ lọc nhiễu — nếu không sẽ bán hụt đúng món đắt nhất.
 */
const BUNDLE_NAME_RE = /(\d+\s*pcs?|\d+\s*pack|set|bundle|combo|kit)/i;

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
  // Ép cent về .99 (charm pricing): vd 28.82 → 28.99, 33.10 → 33.99.
  const roundTo99 = (p: number): number => Math.floor(p) + 0.99;
  const calcPrice = (numericPrice: number): number => {
    const base = priceOverride
      ? (numericPrice + priceOverride.shipFee) * priceOverride.multiplier + priceOverride.extraAdd
      : computeFinalPrice(numericPrice);
    return roundTo99(base);
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
  // Giá gốc áp cho MỌI variant = giá CAO NHẤT trong các variant.
  //
  // Trước đây mỗi màu ăn giá riêng của nó, nên một sản phẩm ra nhiều mức giá khác nhau và
  // màu đắt nhất bị bán hụt. Lấy max rồi mới qua công thức → cả listing một mức giá, không
  // màu nào lỗ. Cũng bỏ luôn nhu cầu "giá fallback" khi một màu không khớp key.
  //
  // Chạy SAU fixInflatedVariantPrices (trong preprocessData) nên max được lấy trên giá đã
  // gỡ phần SHEIN thổi chống crawler.
  const parseMoney = (v: any): number => parseFloat(String(v).replace(",", ".").replace(/[^0-9.]/g, ""));
  const maxRaw = (() => {
    const rows = Object.entries(pricing)
      .map(([name, v]) => ({ name, p: parseMoney(v) }))
      .filter((r) => !isNaN(r.p) && r.p > 0);
    if (rows.length === 0) return NaN;
    if (rows.length === 1) return rows[0].p;

    const sorted = rows.map((r) => r.p).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    // Loại giá lệch quá xa trung vị. fixInflatedVariantPrices chỉ gỡ mức thổi từ 2.7x trở lên
    // (cố ý, để không đụng variant đắt thật), nên phần thổi ~2x còn sót lại — mà lấy MAX thì
    // đúng cái sót đó quyết định giá cả listing. Dữ liệu Hub cho thấy chúng là màu thường bị
    // nhiễu giá: cùng một màu mà "Apricot" 24.69 còn "Apricot 2" chỉ 10.96.
    const outliers = rows.filter((r) => r.p > med * PRICE_OUTLIER_RATIO && !BUNDLE_NAME_RE.test(r.name));
    const pool = rows.filter((r) => !outliers.includes(r));
    for (const o of outliers) {
      console.log(`⚠️  Bỏ giá lệch "${o.name}" = ${o.p} (>${PRICE_OUTLIER_RATIO}x trung vị ${med}) khỏi việc chọn MAX`);
    }
    return Math.max(...(pool.length ? pool : rows).map((r) => r.p));
  })();
  if (!isNaN(maxRaw)) {
    const all = Object.values(pricing).map(parseMoney).filter((n) => !isNaN(n));
    console.log(`💲 Giá gốc dùng cho mọi variant = MAX ${maxRaw} (trong ${all.length} variant: ${all.join(", ")})`);
  }

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

    // Mọi variant dùng chung giá gốc cao nhất (xem maxRaw).
    const numericPrice = maxRaw;
    if (isNaN(numericPrice)) {
      console.warn(`⚠️ Không đọc được giá của variant nào — ô Retail Price sẽ trống!`);
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
