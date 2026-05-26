export const handleBrand = async (page: any, brandName: string): Promise<void> => {
  console.log(`--- Đang xử lý Brand: ${brandName || "No Brand"} ---`);

  const brandTrigger = page.locator(
    '#tiktokSpecifics .el-input__inner[placeholder="Select Brand"]'
  );
  await brandTrigger.click();

  const popper = page.locator(".el-select__popper.create_select_box");
  await popper.waitFor({ state: "visible", timeout: 5000 });

  if (!brandName || brandName.trim() === "") {
    const noBrandItem = popper.locator(".search_product_item").filter({ hasText: /^No Brand$/i });
    await noBrandItem.click();
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
