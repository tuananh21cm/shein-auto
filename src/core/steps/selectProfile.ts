/**
 * Tìm option profile trên dropdown 4Seller match flexible:
 *   1. Exact case-insensitive với targetProfile (vd "P5-022_US")
 *   2. Fallback: bỏ suffix `_XX` (vd "P5-022")
 *   3. Fallback: target không có suffix, thử thêm `_US` (legacy)
 *
 * Trả về index của option khớp hoặc -1.
 */
const findProfileOption = async (
  page: any,
  targetProfile: string
): Promise<{ index: number; matchedTitle: string } | null> => {
  // Đợi ít nhất 1 option xuất hiện
  await page.waitForSelector(".el-select-dropdown__item span[title]", {
    state: "visible",
    timeout: 15000,
  });

  const options = page.locator(".el-select-dropdown__item span[title]");
  const count = await options.count();

  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = ((await options.nth(i).getAttribute("title")) ?? "").trim();
    titles.push(t);
  }

  const normalize = (s: string) => s.toLowerCase().trim();
  const target = normalize(targetProfile);
  const targetNoSuffix = target.replace(/_[a-z]{2}$/i, "");
  const targetWithUs = target.endsWith("_us") ? target : `${target}_us`;

  // Thử lần lượt
  const tries = [
    { variant: target, label: "exact" },
    { variant: targetNoSuffix, label: "no-suffix" },
    { variant: targetWithUs, label: "with-_us" },
  ];

  for (const { variant, label } of tries) {
    if (!variant) continue;
    const idx = titles.findIndex((t) => normalize(t) === variant);
    if (idx >= 0) {
      if (label !== "exact") {
        console.log(`🔎 Profile match qua ${label}: "${targetProfile}" → "${titles[idx]}"`);
      }
      return { index: idx, matchedTitle: titles[idx] };
    }
  }
  console.warn(`❌ Không tìm thấy profile match. Available: ${titles.join(", ")}`);
  return null;
};

/**
 * Chọn Profile (shop) trên 4Seller dropdown. Throw nếu không tìm thấy
 * để tránh đăng nhầm shop.
 */
export const selectProfile = async (page: any, targetProfile: string): Promise<void> => {
  console.log(`🎯 Profile cần chọn dựa trên folder: ${targetProfile}`);

  try {
    await page.click("#shopInfo .el-input__inner");

    const found = await findProfileOption(page, targetProfile);
    if (!found) {
      throw new Error("not-found");
    }
    const profileOption = page
      .locator(".el-select-dropdown__item span[title]")
      .nth(found.index);
    await profileOption.click();
    console.log(`✅ Đã chọn thành công Profile: ${found.matchedTitle}`);

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
  // Tách theo " / " (dấu phân cấp trong config) — KHÔNG dùng "/" vì vài tên category
  // chứa "/" bên trong (vd "Breast Cream/Lotion", "Coffee Beans/Tea Leaves").
  const categories = categoryPath.split(" / ").map((item) => item.trim()).filter(Boolean);
  console.log("Bắt đầu quy trình chọn Category...", categories);

  const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/\s*&\s*/g, " & ").trim();

  for (let i = 0; i < categories.length; i++) {
    const catName = categories[i];
    console.log(`Đang xử lý cấp ${i}: ${catName}`);
    // 1. Khớp title chính xác (nhanh nhất — tên config lấy từ chính API 4Seller nên thường trúng).
    let targetItem = page.locator(`.category_select[index="${i}"] .category_select__item[title="${catName}"]`);
    try {
      await targetItem.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      // 2. Fallback: khớp CHUẨN HOÁ với mọi option ở cấp này (chịu lệch hoa/thường/space/&).
      const items = page.locator(`.category_select[index="${i}"] .category_select__item`);
      const cnt = await items.count().catch(() => 0);
      const target = norm(catName);
      let matchIdx = -1;
      const avail: string[] = [];
      for (let k = 0; k < cnt; k++) {
        const t = ((await items.nth(k).getAttribute("title").catch(() => "")) ?? "").trim();
        avail.push(t);
        if (matchIdx < 0 && norm(t) === target) matchIdx = k;
      }
      if (matchIdx < 0) {
        throw new Error(
          `Không tìm thấy category "${catName}" ở cấp ${i}. Option có sẵn: ${avail.join(" | ")}`
        );
      }
      console.log(`🔎 Category cấp ${i} khớp chuẩn-hoá: "${catName}" → "${avail[matchIdx]}"`);
      targetItem = items.nth(matchIdx);
    }
    try {
      await targetItem.scrollIntoViewIfNeeded();
      await targetItem.click();
      await page.waitForTimeout(800);
    } catch {
      throw new Error(`Category "${catName}" cấp ${i} không click được (bị chặn?).`);
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
