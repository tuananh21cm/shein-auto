import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { safeCleanupDir } from "./cleanupTemp";
import { workerConfig } from "../../config/appConfig";
import { remakeImage } from "../../utils/remakeImage";

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

/**
 * Remake 1 file ảnh đã tải (chống trùng ảnh giữa các shop). Trả về path ảnh
 * mới; nếu tắt config hoặc lỗi → trả lại path gốc để upload vẫn chạy.
 */
const applyRemake = async (localPath: string, seedKey: string): Promise<string> => {
  const cfg = workerConfig().imageRemake;
  if (!cfg?.enabled) return localPath;
  const outPath = localPath.replace(/\.jpg$/i, "_rmk.jpg");
  try {
    await remakeImage(localPath, outPath, {
      preset: cfg.preset,
      flip: cfg.flip,
      seed: cfg.perShopSeed ? seedKey : undefined,
    });
    return outPath;
  } catch (e) {
    console.warn(`⚠️ Remake ảnh fail (${seedKey}) — dùng ảnh gốc:`, (e as Error).message);
    return localPath;
  }
};

export const uploadProductImages = async (
  page: any,
  imageUrls: string[],
  remakeSeed?: string
): Promise<void> => {
  console.log("--- Bắt đầu quy trình Upload Ảnh (Bản an toàn đa luồng) ---");

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(__dirname, `temp_images_${uniqueId}`);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  try {
    // Download song song — tăng tốc N lần so với for-await sequential.
    // Sau khi tải xong remake từng ảnh (seed theo shop) để chống trùng.
    const t0 = Date.now();
    const localFilePaths = await Promise.all(
      imageUrls.map(async (url, i) => {
        const filePath = path.join(tempDir, `img_${i}.jpg`);
        await downloadToFile(url, filePath);
        return applyRemake(filePath, `${remakeSeed ?? "rnd"}:p:${i}`);
      })
    );
    console.log(`⬇️ [${uniqueId}] Download${workerConfig().imageRemake?.enabled ? "+remake" : ""} ${imageUrls.length} ảnh mất ${Math.round((Date.now() - t0) / 1000)}s`);

    const productUploadContainer = page.locator(".file_upload__index").first();
    const fileInput = productUploadContainer.locator("input.file_upload__input");
    await fileInput.waitFor({ state: "attached" });

    console.log(`[${uniqueId}] Đang đẩy ${localFilePaths.length} ảnh vào hệ thống...`);
    const imgsBefore = await productUploadContainer.locator("img").count();
    await fileInput.setInputFiles(localFilePaths);

    // Smart wait thay vì fixed sleep N×7s — poll img count đến khi đạt expected
    // hoặc stable trong stableMs liên tiếp (server xử lý xong).
    const expectedTotal = imgsBefore + localFilePaths.length;
    const maxWaitMs = Math.max(60_000, localFilePaths.length * workerConfig().imageUploadWaitPerImageMs);
    const stableMs = 3_000; // count không đổi trong 3s = upload xong
    console.log(`[${uniqueId}] Smart wait: target ${expectedTotal} ảnh, max ${maxWaitMs / 1000}s...`);

    const tStart = Date.now();
    let lastCount = imgsBefore;
    let lastChange = Date.now();
    let imgsAfter = imgsBefore;
    while (Date.now() - tStart < maxWaitMs) {
      const currentCount = await productUploadContainer.locator("img").count();
      if (currentCount !== lastCount) {
        lastCount = currentCount;
        lastChange = Date.now();
      }
      imgsAfter = currentCount;
      if (currentCount >= expectedTotal) break;
      if (currentCount > imgsBefore && Date.now() - lastChange > stableMs) break;
      await page.waitForTimeout(500);
    }
    console.log(
      `✅ [${uniqueId}] Upload xong sau ${Math.round((Date.now() - tStart) / 1000)}s. ${imgsBefore} → ${imgsAfter} ảnh.`
    );
  } catch (error) {
    console.error(`❌ [${uniqueId}] Lỗi upload ảnh sản phẩm:`, error);
    throw error;
  } finally {
    safeCleanupDir(tempDir, uniqueId);
  }
};

export const uploadVariantImages = async (
  page: any,
  variantImages: VariantImageParam[],
  remakeSeed?: string
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

      // Download song song trong từng màu — vẫn upload tuần tự giữa các màu
      // (vì mỗi màu là 1 DOM element riêng + 4Seller có thể không thích upload đồng thời)
      const tDl = Date.now();
      const downloaded = await Promise.all(
        imageUrls.map(async (url, i) => {
          const localPath = path.join(
            tempDir,
            `${searchColor.replace(/\s+/g, "_")}_${i}_${Date.now()}.jpg`
          );
          await downloadToFile(url, localPath);
          return applyRemake(localPath, `${remakeSeed ?? "rnd"}:${searchColor}:${i}`);
        })
      );
      localPaths.push(...downloaded);
      console.log(`⬇️ Variant "${searchColor}": download ${imageUrls.length} ảnh mất ${Math.round((Date.now() - tDl) / 1000)}s`);

      const targetBox = variantContainer.first();
      await targetBox.scrollIntoViewIfNeeded();

      const fileInput = targetBox.locator("input.file_upload__input");
      await fileInput.waitFor({ state: "attached" });

      // Đếm ảnh có trước, set files, rồi smart wait đạt expected
      const imgsBefore = await targetBox.locator("img").count();
      const expected = imgsBefore + localPaths.length;
      await fileInput.setInputFiles(localPaths);

      const tUp = Date.now();
      const maxWait = 30_000;
      const stable = 2_000;
      let last = imgsBefore;
      let lastChange = Date.now();
      while (Date.now() - tUp < maxWait) {
        const c = await targetBox.locator("img").count();
        if (c !== last) { last = c; lastChange = Date.now(); }
        if (c >= expected) break;
        if (c > imgsBefore && Date.now() - lastChange > stable) break;
        await page.waitForTimeout(400);
      }
      console.log(`✅ "${searchColor}": ${localPaths.length} ảnh upload (${imgsBefore}→${last}) trong ${Math.round((Date.now() - tUp) / 1000)}s`);
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
