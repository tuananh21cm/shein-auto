import { pricing } from "../../config/appConfig";

const CERT_FIELDS = [
  "Dangerous Goods Or Hazardous Materials",
  "CA Prop 65: Repro. Chems",
  "CA Prop 65: Carcinogens",
  "Confirm Any Regulatory Marking Or Label",
];

export const fillShippingAndCertification = async (page: any): Promise<void> => {
  console.log("--- Đang điền thông tin Vận chuyển & Chứng chỉ (Đa thị trường) ---");

  try {
    const p = pricing();
    await page.getByPlaceholder("Enter the product weight").first().fill(p.defaultWeight);

    // Form 4Seller có NHIỀU ô placeholder "Length"/"Width"/"Height" (size chart, section khác)
    // → phải scope vào đúng form-item "Product Dimensions", tuyệt đối không match toàn trang.
    const dimRow = page.locator(".el-form-item").filter({ hasText: "Product Dimensions" }).first();
    const dimScoped = (await dimRow.count()) > 0;
    const scope = dimScoped ? dimRow : page;
    const fillDim = async (ph: string, val: string) => {
      const inp = scope.getByPlaceholder(ph);
      if ((await inp.count()) > 0) { await inp.first().fill(val); return true; }
      return false;
    };
    await fillDim("Length", p.defaultDimensions.length);
    await fillDim("Width", p.defaultDimensions.width);
    if (!(await fillDim("Height", p.defaultDimensions.height)) && dimScoped) {
      // Không có placeholder Height → ô thứ 3 trong dimensions row
      await dimRow.locator("input.el-input__inner").nth(2).fill(p.defaultDimensions.height);
    }
    console.log(`✅ Đã điền Dimensions L/W/H (scope: ${dimScoped ? "Product Dimensions row" : "toàn trang"})`);

    for (const labelText of CERT_FIELDS) {
      const formItem = page.locator(".el-form-item").filter({ hasText: labelText });
      const targetInput = formItem.locator("input.el-input__inner");

      if (await targetInput.isVisible()) {
        console.log(`🔎 Đang xử lý trường: ${labelText}`);
        await targetInput.scrollIntoViewIfNeeded();
        await targetInput.click();
        await page.waitForTimeout(500);

        const noOption = page
          .locator(".el-select-dropdown__item")
          .filter({ hasText: /^No$/ })
          .filter({ has: page.locator("span") });

        const count = await noOption.count();
        let clicked = false;
        for (let i = 0; i < count; i++) {
          const opt = noOption.nth(i);
          if (await opt.isVisible()) {
            await opt.click();
            clicked = true;
            console.log(`✅ Đã chọn "No" cho: ${labelText}`);
            break;
          }
        }

        if (!clicked) {
          console.log(`⚠️ Không tìm thấy option "No" visible cho ${labelText}, thử fallback...`);
          const fallbackOpt = page
            .locator(".el-select-dropdown__item")
            .filter({ hasText: "No" })
            .filter({ hasNotText: "Not" })
            .last();
          if (await fallbackOpt.isVisible()) {
            await fallbackOpt.click();
            console.log(`✅ Đã chọn fallback "No" cho: ${labelText}`);
          } else {
            console.error(`⚠️ Vẫn không click được "No" cho ${labelText}.`);
            await page.keyboard.press("Escape");
          }
        }
        await page.waitForTimeout(300);
      }
    }
    console.log("✅ Hoàn thành toàn bộ mục Shipping & Certification.");
  } catch (error) {
    console.error("❌ Lỗi trong quá trình điền Shipping & Cert:", error);
    throw error;
  }
};
