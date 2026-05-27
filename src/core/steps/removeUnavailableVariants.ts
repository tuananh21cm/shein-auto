/**
 * Xóa các dòng variant trên bảng 4Seller mà (color, size) không có trong
 * available_matrix do tampermonkey gửi lên.
 *
 * Trên SHEIN, mỗi màu có thể có set size khác nhau (vd Red: S/M/L, Blue: S/M/L/XL).
 * 4Seller variation table mặc định cross-product (mọi color × mọi size). Phải dọn rác.
 */
export const removeUnavailableVariants = async (
  page: any,
  availableMatrix: Record<string, string[]>
): Promise<void> => {
  if (!availableMatrix || Object.keys(availableMatrix).length === 0) return;

  console.log("--- Dọn variants không available theo available_matrix ---");

  // Normalize matrix: lowercase color & size để so sánh case-insensitive
  const matrix: Record<string, Set<string>> = {};
  for (const [color, sizes] of Object.entries(availableMatrix)) {
    matrix[color.toLowerCase().trim()] = new Set(
      sizes.map((s) => s.toLowerCase().trim())
    );
  }

  await page.waitForSelector("tbody tr.custom_draft_table_body_tr");

  const rows = page.locator("tbody tr.custom_draft_table_body_tr");
  const rowCount = await rows.count();
  let removed = 0;

  // Duyệt ngược từ dưới lên để khỏi lệch index khi xóa
  for (let i = rowCount - 1; i >= 0; i--) {
    const row = rows.nth(i);
    const fullTitle = await row
      .locator("td:first-child div.line_ellipsis")
      .getAttribute("title");
    if (!fullTitle) continue;

    // Format: "Color/Size" hoặc "Color/Size/Width"
    const parts = fullTitle.split("/").map((p: string) => p.trim());
    if (parts.length < 2) continue;
    const color = parts[0].toLowerCase();
    const size = parts[1].toLowerCase();

    const allowedSizes = matrix[color];
    if (!allowedSizes || !allowedSizes.has(size)) {
      console.log(`🗑️ Xoá variant không có trong matrix: ${fullTitle}`);
      const removeBtn = row.locator("svg.icon_remove");
      try {
        await removeBtn.scrollIntoViewIfNeeded();
        await removeBtn.click();
        await page.waitForTimeout(250);
        removed++;
      } catch (err) {
        console.warn(`⚠️ Không xoá được row ${fullTitle}:`, err);
      }
    }
  }

  console.log(`✅ Đã dọn ${removed} variants không available.`);
};
