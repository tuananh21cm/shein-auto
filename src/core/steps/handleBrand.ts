export const handleBrand = async (page: any, brandName: string): Promise<void> => {
  console.log(`--- Đang xử lý Brand: ${brandName || "No Brand"} ---`);

  const brandTrigger = page.locator(
    '#tiktokSpecifics .el-input__inner[placeholder="Select Brand"]'
  );
  await brandTrigger.click();

  // 4Seller render NHIỀU popper (1 đang mở aria-hidden="false" + 1 cũ ẩn aria-hidden="true"
  // data-popper-escaped) → selector khớp 2 element → strict mode lỗi. Chỉ nhắm popper ĐANG HIỆN.
  const popper = page.locator(".el-select__popper.create_select_box").filter({ visible: true }).first();
  await popper.waitFor({ state: "visible", timeout: 5000 });

  if (!brandName || brandName.trim() === "") {
    // Dropdown load list async → chờ render. Match "No Brand" bằng string (chuẩn hoá whitespace,
    // case-insensitive) — KHÔNG dùng regex neo ^...$ (dễ trượt do whitespace/icon → click treo).
    let noBrandItem = popper.locator(".search_product_item", { hasText: "No Brand" }).first();
    try {
      await noBrandItem.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      // Fallback: bắt theo text bất kỳ phần tử trong popper.
      noBrandItem = popper.getByText("No Brand", { exact: false }).first();
      await noBrandItem.waitFor({ state: "visible", timeout: 8000 });
    }
    await noBrandItem.click();
    await page.waitForTimeout(400);
    console.log("✅ Đã chọn No Brand");
    return;
  }

  const searchInput = popper.locator('input[placeholder="Search all brands on tiktok"]');
  await searchInput.fill(brandName);
  await popper.locator(".search_brand .er_icon").click();
  await page.waitForTimeout(1000);

  const matchedOption = popper.locator(".search_product_item div").filter({
    hasText: new RegExp(`^${brandName}$`, "i"),
  });

  if ((await matchedOption.count()) > 0) {
    await matchedOption.first().click();
    console.log(`✅ Đã chọn Brand có sẵn: ${brandName}`);
  } else {
    console.log(`⚠️ Không thấy "${brandName}", đang thêm mới...`);
    const enterInput = popper.locator('input[placeholder="Enter Brand"]');
    await enterInput.fill(brandName);
    const addBtn = popper.locator(".create_btn button");
    await addBtn.click();
    console.log(`✅ Đã hoàn thành Add Brand: ${brandName}`);
  }

  await page.waitForTimeout(500);
};
