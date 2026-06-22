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
    await page.getByPlaceholder("Enter the product weight").fill(p.defaultWeight);
    // exact:true — tránh khớp nhầm "Select Clothing/Sleeve/Hem Length" khi Specifics đã mở rộng.
    await page.getByPlaceholder("Length", { exact: true }).fill(p.defaultDimensions.length);
    await page.getByPlaceholder("Width", { exact: true }).fill(p.defaultDimensions.width);

    const heightInput = page.locator('input[placeholder="Height"]');
    if ((await heightInput.count()) > 0) {
      await heightInput.first().fill(p.defaultDimensions.height);
    } else {
      const dimRow = page
        .locator(".el-form-item")
        .filter({ hasText: "Product Dimensions" });
      await dimRow.locator("input.el-input__inner").nth(2).fill(p.defaultDimensions.height);
    }
    console.log(`✅ Đã điền Height: ${p.defaultDimensions.height}`);

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
