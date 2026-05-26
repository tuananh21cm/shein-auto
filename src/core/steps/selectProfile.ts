/**
 * Chọn Profile (shop) trên 4Seller dropdown. Throw nếu không tìm thấy
 * để tránh đăng nhầm shop.
 */
export const selectProfile = async (page: any, targetProfile: string): Promise<void> => {
  console.log(`🎯 Profile cần chọn dựa trên folder: ${targetProfile}`);

  try {
    await page.click("#shopInfo .el-input__inner");
    const optionSelector = `.el-select-dropdown__item span[title="${targetProfile}"]`;
    const profileOption = page.locator(optionSelector).last();
    await profileOption.waitFor({ state: "visible", timeout: 15000 });
    await profileOption.click();
    console.log(`✅ Đã chọn thành công Profile: ${targetProfile}`);

    const messageBox = page.locator(".el-message-box");
    const confirmButton = messageBox.locator('button.el-button--primary:has-text("Confirm")');
    await page.keyboard.press("Enter");

    try {
      await messageBox.waitFor({ state: "visible", timeout: 3000 });
      console.log("⚠️ Phát hiện cảnh báo reset nội dung, đang bấm Confirm...");
      await confirmButton.click();
      await messageBox.waitFor({ state: "hidden" });
      console.log("✅ Đã vượt qua popup xác nhận.");
    } catch {
      console.log("ℹ️ Không xuất hiện popup xác nhận, tiếp tục.");
    }

    await page.waitForTimeout(1500);
  } catch {
    throw new Error(
      `Không tìm thấy Profile "${targetProfile}" trên giao diện 4Seller. Dừng để tránh đăng sai shop.`
    );
  }
};

/**
 * Chọn category multi-level dropdown từ path "A / B / C".
 * Throw nếu không tìm thấy cấp nào để fail listing hơn là post sai category.
 */
export const selectCategory = async (page: any, categoryPath: string): Promise<void> => {
  await page.click("span:has-text('Browse Categories')");
  const categories = categoryPath.split("/").map((item) => item.trim());
  console.log("Bắt đầu quy trình chọn Category...", categories);

  for (let i = 0; i < categories.length; i++) {
    const catName = categories[i];
    console.log(`Đang xử lý cấp ${i}: ${catName}`);
    const itemSelector = `.category_select[index="${i}"] .category_select__item[title="${catName}"]`;
    const targetItem = page.locator(itemSelector);
    try {
      await targetItem.waitFor({ state: "visible", timeout: 5000 });
      await targetItem.scrollIntoViewIfNeeded();
      await targetItem.click();
      await page.waitForTimeout(800);
    } catch {
      throw new Error(`Không tìm thấy category "${catName}" ở cấp ${i}.`);
    }
  }

  const saveBtn = page.locator('footer.el-dialog__footer button:has-text("Save")').last();
  if (await saveBtn.isVisible()) {
    await saveBtn.click();
    console.log("Đã bấm Save Category.");
  }
  const messageBox = page.locator(".el-message-box.el-message-box--center");
  const confirmBtn = page.locator('.el-message-box__btns button:has-text("Confirm")');
  await page.waitForTimeout(500);
  if (await messageBox.isVisible()) {
    console.log("Phát hiện popup xác nhận, đang bấm Confirm...");
    await confirmBtn.click();
    await messageBox.waitFor({ state: "hidden" });
  }
};
