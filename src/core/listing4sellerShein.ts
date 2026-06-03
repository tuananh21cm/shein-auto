import fs from "fs";
import { chromium } from "playwright-core";
import { configCookie } from "../utils/configCookie";
import { genTitleFromShein } from "../services/gemini/genTitleFromShein";
import { cleanTitle } from "../utils/cleanTitle";
import { workerConfig } from "../config/appConfig";
import { resolveBrandForUser } from "../state/userDirs";

import { getProfileNameFromFolder } from "./steps/randomUtils";
import { findCategory } from "./steps/findCategory";
import { preprocessData } from "./steps/preprocessData";
import { selectProfile, selectCategory } from "./steps/selectProfile";
import { fillVariations } from "./steps/fillVariations";
import { fillTableData } from "./steps/fillTableData";
import { uploadProductImages, uploadVariantImages } from "./steps/uploadImages";
import { handleBrand } from "./steps/handleBrand";
import {
  fillDescription,
  generateDescriptionHtml,
  selectDescriptionImages,
  uploadDescriptionImages,
} from "./steps/fillDescription";
import { fillShippingAndCertification } from "./steps/fillShipping";
import { handleSizeChartUpload } from "./steps/handleSizeChart";
import { detectPublishOutcome, checkPageErrors, captureScreenshot } from "./steps/publishAndDetect";
import { removeUnavailableVariants } from "./steps/removeUnavailableVariants";

export { findCategory, handleBrand, fillVariations, fillTableData };
export { uploadProductImages, uploadVariantImages };
export { fillDescription, generateDescriptionHtml };

/**
 * Sau mỗi major step, gọi để fail-fast nếu 4Seller đã hiện error toast.
 * Không throw cho mọi lỗi UI (vì có những toast cũ chưa tắt) — chỉ với error
 * vừa xuất hiện (visible).
 */
const assertNoErrors = async (page: any, after: string) => {
  const err = await checkPageErrors(page);
  if (err) {
    throw new Error(`Lỗi UI sau bước "${after}": ${err}`);
  }
};

/**
 * Orchestrator: chạy 1 lần listing cho 1 file JSON.
 * @param jsonFile relative path dạng "SheinAuto/<shop>/<file>.json"
 * @param opts.dryRun - nếu true, không click Save & Publish (chỉ tạo draft)
 */
export const listing4sellerShein = async (
  jsonFile: string,
  opts?: {
    dryRun?: boolean;
    cookieUser?: string;
    headless?: boolean;
    pricing?: { shipFee: number; multiplier: number; extraAdd: number };
  }
): Promise<void> => {
  // Cookie load theo user (owner của file). Fallback global nếu user chưa upload.
  const cookie = await configCookie(opts?.cookieUser ?? null);
  const headless = opts?.headless ?? workerConfig().headless;
  const browser = await chromium.launch({ headless });
  const browserContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await browserContext.addCookies(cookie);
  const page = await browserContext.newPage();

  page.on("dialog", async (dialog) => {
    console.warn(`⚠️ [Dialog] type="${dialog.type()}" msg="${dialog.message()}" → tự động accept`);
    await dialog.accept();
  });

  try {
    console.log(`📄 Đọc file: ${jsonFile}`);
    const pathMod = await import("path");
    if (!pathMod.isAbsolute(jsonFile)) {
      throw new Error(
        `listing4sellerShein chỉ nhận absolute path. Nhận được: "${jsonFile}"`
      );
    }
    const jsonContent = await fs.promises.readFile(jsonFile, "utf-8");
    const data = JSON.parse(jsonContent);
    const targetProfile = getProfileNameFromFolder(jsonFile);

    // KICK OFF Gemini calls NGAY ĐẦU — chạy song song với toàn bộ page setup
    // (goto, waitLoad, selectProfile ~7-10s). Đến khi cần fill title, Gemini
    // gần như đã xong, đặc biệt khi cache hit (instant).
    const titlePromise = genTitleFromShein(data.product_name);
    const categoryPromise = findCategory(data.category);

    await page.goto("https://www.4seller.com/web/listing/tiktok/create.html?status=draft", {
      timeout: 30000,
    });
    await page.waitForLoadState("load");
    await page.waitForTimeout(2000);

    // Nếu cookie hết hạn, 4Seller redirect về login
    if (page.url().includes("/login") || page.url().includes("/sign-in")) {
      throw new Error("Cookie 4Seller hết hạn — bị redirect về login");
    }

    await selectProfile(page, targetProfile);
    await assertNoErrors(page, "selectProfile");

    // Lấy kết quả Gemini (await — đã chạy song song trong lúc select profile)
    const aiTitle = await titlePromise;
    // Brand resolve chỉ theo user/shop (đã bỏ global). Rỗng = không brand.
    const brand = await resolveBrandForUser(opts?.cookieUser, targetProfile);
    console.log({ targetProfile, brand });
    const finalTitle = cleanTitle(aiTitle, brand);
    console.log(finalTitle);
    await page.fill("#productInfo .el-input.mr_8 .el-input__inner", finalTitle);
    await page.waitForTimeout(2000);

    // Category (AI mapping) — đã promise xong
    const categoryPath = await categoryPromise;
    await selectCategory(page, categoryPath);
    await assertNoErrors(page, "selectCategory");

    await page.click("span:has-text('Has Variations')");
    await page.waitForTimeout(2000);

    // Pre-process: size normalize, dedup, filter, merge product images
    const { mergedProductImages } = preprocessData(data);

    await fillVariations(page, data.listing_variations);
    await assertNoErrors(page, "fillVariations");

    await fillTableData(page, data.variant_price, data.attributes.SKU, 5, data.variant_ids, opts?.pricing);
    await assertNoErrors(page, "fillTableData");

    // Nếu tampermonkey gửi kèm available_matrix (mỗi màu có set size khác nhau),
    // dọn các (color, size) rows không available do 4Seller mặc định cross-product
    if (data.available_matrix && typeof data.available_matrix === "object") {
      await removeUnavailableVariants(page, data.available_matrix);
      await assertNoErrors(page, "removeUnavailableVariants");
    }

    await uploadProductImages(page, mergedProductImages, targetProfile);
    await uploadVariantImages(page, data.variant_images, targetProfile);
    await assertNoErrors(page, "uploadImages");

    await handleBrand(page, data.brand_name);

    const colorList = data.listing_variations?.colors || [];
    const descHtml = generateDescriptionHtml(
      data.product_name,
      data.attributes,
      data.sizes_available,
      colorList
    );
    await fillDescription(page, descHtml);

    if (data.variant_images && data.variant_images.length > 0) {
      const descImages = selectDescriptionImages(data.variant_images);
      console.log(`📸 Đã chọn ${descImages.length} ảnh cho mô tả từ ${data.variant_images.length} variants`);
      await uploadDescriptionImages(page, descImages);
    }

    await fillShippingAndCertification(page);
    await handleSizeChartUpload(page, { size_chart: data.size_chart });
    await assertNoErrors(page, "fillShipping+sizeChart");

    // KHÔNG điền URL Shein gốc — tránh TikTok detect nguồn dropshipping.
    await page.waitForTimeout(3000);

    // Click Save & Publish + detect outcome
    const outcome = await detectPublishOutcome(page, { dryRun: opts?.dryRun });
    console.log(`📊 Publish outcome:`, outcome);

    if (!outcome.ok) {
      const screenshot = outcome.screenshotPath ? `\nScreenshot: ${outcome.screenshotPath}` : "";
      throw new Error(`Publish thất bại: ${outcome.reason}${screenshot}`);
    }

    console.log(`✅ Hoàn thành đăng sản phẩm. ${outcome.reason}`);
  } catch (error: any) {
    // Chụp screenshot final + đính path vào error message để UI hiển thị
    try {
      const sc = await captureScreenshot(page, "fatal-error");
      if (sc) {
        console.error(`📸 Screenshot lỗi: ${sc}`);
        if (error && typeof error.message === "string" && !error.message.includes("Screenshot:")) {
          error.message = `${error.message}\nScreenshot: ${sc}`;
        }
      }
    } catch {
      // ignore
    }
    console.error("Error in listing4sellerShein:", error);

    // Debug pause: nếu headless=false (user muốn xem browser) → giữ browser
    // mở 30s trước khi đóng để user inspect manual.
    if (!headless) {
      console.log("🐛 [DEBUG] headless=false → giữ browser mở 30s để bạn xem manual...");
      try {
        await page.waitForTimeout(30_000);
      } catch {
        // page có thể đã đóng, skip
      }
    }
    throw error;
  } finally {
    await page.close().catch(() => {});
    await browserContext.close().catch(() => {});
    await browser.close().catch(() => {});
  }
};
