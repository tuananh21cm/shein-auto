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
    // 4Seller chèn cột checkbox đầu → KHÔNG ép "td:first-child". Ô variant là ô DUY NHẤT có
    // div.line_ellipsis[title] → locate trực tiếp, bền với việc lệch cột.
    const fullTitle = await row
      .locator("div.line_ellipsis")
      .first()
      .getAttribute("title");
    if (!fullTitle) continue;

    // Format title: "Color/Size" (hoặc "Color/Size/Width"). LƯU Ý: SIZE có thể CHỨA
    // "/" (vd US "8/10 (L)") → KHÔNG split cứng cả chuỗi (sẽ tách nhầm → xoá oan size L).
    // Cách đúng: color = đoạn trước "/" đầu tiên; phần còn lại match theo matrix.
    const firstSlash = fullTitle.indexOf("/");
    if (firstSlash < 0) continue;
    const color = fullTitle.slice(0, firstSlash).trim().toLowerCase();
    const rest = fullTitle.slice(firstSlash + 1).trim().toLowerCase();

    const allowedSizes = matrix[color];
    // Còn hàng nếu rest == 1 size cho phép, hoặc bắt đầu bằng "size/" (khi có thêm
    // attr Width phía sau). Dùng matrix làm chuẩn → "8/10 (l)" khớp đúng, không vỡ.
    const sizeOk =
      !!allowedSizes && [...allowedSizes].some((sz) => rest === sz || rest.startsWith(sz + "/"));
    if (!sizeOk) {
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
