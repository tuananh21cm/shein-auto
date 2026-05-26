interface VariationInput {
  [key: string]: string[];
}

async function processVariationValues(page: any, container: any, values: string[]) {
  for (const value of values) {
    const regex = new RegExp(`^${value}$`, "i");
    const checkbox = container.locator(".el-checkbox").filter({ hasText: regex }).first();

    if (await checkbox.count() > 0) {
      const isChecked = await checkbox
        .locator(".el-checkbox__input")
        .evaluate((node: HTMLElement) => node.classList.contains("is-checked"));

      if (!isChecked) {
        console.log(`Đang tích chọn: ${value}`);
        await checkbox.click();
        await page.waitForTimeout(300);
      }
    } else {
      console.log(`Đang thêm mới giá trị: ${value}`);
      const input = container.locator(".el-input__inner");
      const addBtn = container.locator('button:has-text("Add")');
      await input.fill(value);
      await page.waitForTimeout(200);
      await addBtn.click();
      await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

export const fillVariations = async (page: any, variations: VariationInput): Promise<void> => {
  for (const [key, values] of Object.entries(variations)) {
    if (!values || values.length === 0) continue;

    const attrName =
      key.replace(/s$/, "").charAt(0).toUpperCase() + key.replace(/s$/, "").slice(1);
    console.log(`--- Đang xử lý Variation: ${attrName} ---`);

    let container = page.locator(".attribute_box").filter({
      has: page.locator(`.name:has-text("${attrName}")`),
    });

    if ((await container.count()) === 0) {
      const liItem = page
        .locator(".variation_box .variation_item")
        .filter({ hasText: new RegExp(`^${attrName}$`, "i") });

      if ((await liItem.count()) > 0) {
        console.log(`Kích hoạt ${attrName} từ danh sách đề xuất...`);
        await liItem.click();
      } else {
        console.log(`Không tìm thấy ${attrName}, đang tạo mới qua popup...`);
        await page.locator('button:has-text("Add Variation")').click();
        await page.waitForTimeout(2000);
        const popupInput = page.locator(".w_275 .el-input__inner");
        await popupInput.fill(attrName);
        await page.waitForTimeout(200);
        await page
          .locator('.el-popper.is-light.el-popover.edit_popover button:has-text("Save")')
          .click();
        await page.waitForTimeout(1000);
      }
    }

    container = page.locator(".attribute_box").filter({
      has: page.locator(`.name:has-text("${attrName}")`),
    });

    await processVariationValues(page, container, values);

    try {
      await page.title();
    } catch {
      throw new Error(
        `Page đóng sau khi xử lý variation "${attrName}" — có thể do dialog không được handle hoặc 4Seller navigate đi nơi khác`
      );
    }
  }
};
