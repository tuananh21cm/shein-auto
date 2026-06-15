/**
 * Đặt quantity = 0 cho các dòng variant trên bảng 4Seller mà (color, size)
 * không có trong available_matrix do tampermonkey gửi lên.
 *
 * Trên SHEIN, mỗi màu có thể có set size khác nhau (vd Red: S/M/L, Blue: S/M/L/XL).
 * 4Seller variation table mặc định cross-product (mọi color × mọi size).
 * Thay vì xoá row, ta giữ lại tất cả variant nhưng set qty = 0 cho OOS.
 */
export const setOosVariantQuantity = async (
  page: any,
  availableMatrix: Record<string, string[]>,
  oosMatrix?: Record<string, string[]>
): Promise<void> => {
  if (!availableMatrix || Object.keys(availableMatrix).length === 0) return;

  console.log("--- Set qty = 0 cho variants OOS theo available_matrix ---");

  // Normalize matrix: lowercase color & size để so sánh case-insensitive
  const matrix: Record<string, Set<string>> = {};
  for (const [color, sizes] of Object.entries(availableMatrix)) {
    matrix[color.toLowerCase().trim()] = new Set(
      sizes.map((s) => s.toLowerCase().trim())
    );
  }

  // Tập hợp tất cả color có trong data (available + oos) để phân biệt
  // color OOS 100% (có trong oosMatrix nhưng KHÔNG có trong availableMatrix)
  // vs color hoàn toàn không liên quan (không nên touch)
  const allKnownColors = new Set<string>(
    Object.keys(availableMatrix).map((c) => c.toLowerCase().trim())
  );
  if (oosMatrix) {
    for (const color of Object.keys(oosMatrix)) {
      allKnownColors.add(color.toLowerCase().trim());
    }
  }

  await page.waitForSelector("tbody tr.custom_draft_table_body_tr");

  // Dùng scroll-and-scan giống fillTableData vì 4Seller dùng virtual list
  const ROW_SELECTOR = "tbody tr.custom_draft_table_body_tr";
  const processedVariants = new Set<string>();
  let oosCount = 0;

  let stagnant = 0;
  let passes = 0;
  const MAX_PASSES = 200;

  while (stagnant < 3 && passes < MAX_PASSES) {
    passes++;
    const rows = page.locator(ROW_SELECTOR);
    const rowCount = await rows.count();
    let newlyProcessed = 0;

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);

      let fullTitle: string | null = null;
      try {
        fullTitle = await row
          .locator("div.line_ellipsis[title]")
          .first()
          .getAttribute("title");
      } catch {
        continue; // row bị recycle → bỏ qua, lượt sau xử lý
      }
      if (!fullTitle) continue;
      if (processedVariants.has(fullTitle)) continue;

      // Format: "Color/Size" hoặc "Color/Size/Width"
      const parts = fullTitle.split("/").map((p: string) => p.trim());
      if (parts.length < 2) {
        processedVariants.add(fullTitle);
        newlyProcessed++;
        continue;
      }
      const color = parts[0].toLowerCase();
      const size = parts[1].toLowerCase();

      // Chỉ xử lý colors thuộc data đã scrape
      if (!allKnownColors.has(color)) {
        processedVariants.add(fullTitle);
        newlyProcessed++;
        continue;
      }

      const allowedSizes = matrix[color];
      const isOos = !allowedSizes || !allowedSizes.has(size);

      if (isOos) {
        try {
          await row.evaluate((el: HTMLElement) =>
            el.scrollIntoView({ block: "center", inline: "nearest" })
          );
          await page.waitForTimeout(120);

          // Input thứ tự trong row: [0]=SKU, [1]=QTY, [2]=Price
          const rowInputs = row.locator("td input.el-input__inner");
          await rowInputs.nth(1).fill("0");
          console.log(`🔻 Set qty=0 cho variant OOS: ${fullTitle}`);
          oosCount++;
        } catch (err) {
          console.warn(`⚠️ Không set được qty=0 cho row ${fullTitle}:`, err);
          continue; // không add vào processed, lượt sau thử lại
        }
      }

      processedVariants.add(fullTitle);
      newlyProcessed++;
    }

    await page.keyboard.press("PageDown");
    await page.waitForTimeout(500);
    stagnant = newlyProcessed > 0 ? 0 : stagnant + 1;
  }

  console.log(`✅ Đã set qty=0 cho ${oosCount} variants OOS (scan ${processedVariants.size} rows, passes=${passes}).`);
};

// Backward-compatible alias
export const removeUnavailableVariants = setOosVariantQuantity;
