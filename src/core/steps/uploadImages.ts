import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { safeCleanupDir } from "./cleanupTemp";
import { workerConfig } from "../../config/appConfig";

interface VariantImageParam {
  [color: string]: string | string[];
}

const downloadToFile = async (url: string, filePath: string): Promise<void> => {
  const response = await axios({ url, method: "GET", responseType: "stream" });
  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on("finish", () => {
      writer.close();
      resolve(true);
    });
    writer.on("error", (err) => {
      writer.close();
      reject(err);
    });
  });
};

export const uploadProductImages = async (page: any, imageUrls: string[]): Promise<void> => {
  console.log("--- Bắt đầu quy trình Upload Ảnh (Bản an toàn đa luồng) ---");

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(__dirname, `temp_images_${uniqueId}`);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const localFilePaths: string[] = [];

  try {
    for (let i = 0; i < imageUrls.length; i++) {
      const filePath = path.join(tempDir, `img_${i}.jpg`);
      await downloadToFile(imageUrls[i], filePath);
      localFilePaths.push(filePath);
    }

    const productUploadContainer = page.locator(".file_upload__index").first();
    const fileInput = productUploadContainer.locator("input.file_upload__input");
    await fileInput.waitFor({ state: "attached" });

    console.log(`[${uniqueId}] Đang đẩy ${localFilePaths.length} ảnh vào hệ thống...`);
    const imgsBefore = await productUploadContainer.locator("img").count();
    await fileInput.setInputFiles(localFilePaths);

    console.log(`[${uniqueId}] Baseline: ${imgsBefore} ảnh. Chờ thumbnail đầu tiên (max 60s)...`);
    try {
      await productUploadContainer
        .locator("img")
        .first()
        .waitFor({ state: "visible", timeout: 60000 });
      console.log(`[${uniqueId}] Thumbnail đầu tiên xuất hiện!`);
    } catch {
      console.warn(`⚠️ [${uniqueId}] Không thấy thumbnail sau 60s — tiếp tục fixed wait...`);
    }

    const fixedWait = localFilePaths.length * workerConfig().imageUploadWaitPerImageMs;
    console.log(`[${uniqueId}] Fixed wait ${fixedWait / 1000}s cho ${localFilePaths.length} ảnh...`);
    await page.waitForTimeout(fixedWait);

    const imgsAfter = await productUploadContainer.locator("img").count();
    console.log(`✅ [${uniqueId}] Upload xong. ${imgsBefore} → ${imgsAfter} ảnh trong container.`);
  } catch (error) {
    console.error(`❌ [${uniqueId}] Lỗi upload ảnh sản phẩm:`, error);
    throw error;
  } finally {
    safeCleanupDir(tempDir, uniqueId);
  }
};

export const uploadVariantImages = async (
  page: any,
  variantImages: VariantImageParam[]
): Promise<void> => {
  console.log("--- Bắt đầu Upload ảnh Variant (Bản Multi-Image US/DE/FR) ---");

  const imageMap: { [key: string]: string[] } = {};
  for (const item of variantImages) {
    for (const [key, value] of Object.entries(item)) {
      imageMap[key] = Array.isArray(value) ? value : [value];
    }
  }

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(process.cwd(), `temp_variants_${uniqueId}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const failedColors: string[] = [];

  for (const [colorName, imageUrls] of Object.entries(imageMap)) {
    const searchColor = colorName.trim();
    const localPaths: string[] = [];

    try {
      // Universal selector: support cả cấu trúc US cũ và DE/FR mới
      const variantContainer = page
        .locator(
          [".variant_imgs li", ".variant_multiple_imgs .flex.column"].join(", ")
        )
        .filter({
          hasText: new RegExp(`${searchColor}`, "i"),
        });

      const count = await variantContainer.count();

      if (count === 0) {
        const currentUIColors = await page
          .locator(".variant_imgs .line_ellipsis, .variant_multiple_imgs .flex.column")
          .allInnerTexts();
        console.warn(`⚠️ Bỏ qua màu: "${searchColor}". UI hiện có:`, currentUIColors);
        continue;
      }

      for (let i = 0; i < imageUrls.length; i++) {
        const localPath = path.join(
          tempDir,
          `${searchColor.replace(/\s+/g, "_")}_${i}_${Date.now()}.jpg`
        );
        await downloadToFile(imageUrls[i], localPath);
        localPaths.push(localPath);
      }

      const targetBox = variantContainer.first();
      await targetBox.scrollIntoViewIfNeeded();

      const fileInput = targetBox.locator("input.file_upload__input");
      await fileInput.waitFor({ state: "attached" });
      await fileInput.setInputFiles(localPaths);

      console.log(`✅ Đã upload ${localPaths.length} ảnh cho: ${searchColor}`);

      try {
        await targetBox.locator("img").first().waitFor({ state: "visible", timeout: 15000 });
      } catch {
        console.warn(`⚠️ Thumbnail chưa hiện sau 15s cho: ${searchColor}`);
      }
    } catch (innerError) {
      console.error(`❌ Lỗi tại màu ${searchColor}:`, innerError);
      failedColors.push(searchColor);
      continue;
    }
  }

  safeCleanupDir(tempDir, `variant_${uniqueId}`);

  if (failedColors.length > 0) {
    throw new Error(
      `Upload variant images thất bại cho ${failedColors.length} màu: ${failedColors.join(", ")}`
    );
  }
  console.log("--- Hoàn tất chu kỳ upload ảnh Variant ---");
};
