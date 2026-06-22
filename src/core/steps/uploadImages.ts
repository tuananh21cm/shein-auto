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

const downloadToFile = async (url: string, filePath: string, attempts = 3): Promise<void> => {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
        timeout: 30000,
      });
      const writer = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => {
        response.data.pipe(writer);
        response.data.on("error", (err: any) => {
          writer.close();
          reject(err);
        });
        writer.on("finish", () => {
          writer.close();
          resolve();
        });
        writer.on("error", (err) => {
          writer.close();
          reject(err);
        });
      });
      return;
    } catch (err: any) {
      lastErr = err;
      if (i < attempts) {
        console.warn(
          `⚠️ Download lỗi (lần ${i}/${attempts}): ${err?.message} — thử lại sau ${i * 0.8}s`
        );
        await new Promise((r) => setTimeout(r, 800 * i));
      }
    }
  }
  throw lastErr;
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
  remakeSeed?: string,
  opts?: { insertAfterMainPath?: string | null; prependLocalPath?: string | null }
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

    // Ảnh "nhiều màu" làm ảnh MAIN (index 0) — KHÔNG remake.
    if (opts?.prependLocalPath && fs.existsSync(opts.prependLocalPath)) {
      localFilePaths.unshift(opts.prependLocalPath);
      console.log(`🎨 [${uniqueId}] Prepend ảnh nhiều màu làm ảnh main (vị trí 0)`);
    }
    // Chèn ảnh GỘP Size Guide ngay sau ảnh main (index 1) — KHÔNG remake để chữ giữ sắc nét.
    if (opts?.insertAfterMainPath && fs.existsSync(opts.insertAfterMainPath)) {
      const at = Math.min(1, localFilePaths.length);
      localFilePaths.splice(at, 0, opts.insertAfterMainPath);
      console.log(`📐 [${uniqueId}] Chèn ảnh Size Guide vào gallery ở vị trí ${at} (sau ảnh main)`);
    }

    // Defensive: ảnh MAIN TikTok tối đa 9 (gốc + prepend showcase + insert size guide) → cắt nếu dư.
    const MAX_MAIN_IMAGES = 9;
    if (localFilePaths.length > MAX_MAIN_IMAGES) {
      console.log(`✂️ [${uniqueId}] Ảnh main ${localFilePaths.length} → cắt còn ${MAX_MAIN_IMAGES} (giới hạn 4Seller)`);
      localFilePaths.splice(MAX_MAIN_IMAGES);
    }

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

/**
 * Bật/tắt toggle "Variant Image" (el-switch, có dấu * required) trên 4Seller.
 * POD: 1 ảnh design dùng chung mọi màu → TẮT để khỏi phải điền ảnh từng màu.
 * Dùng xpath: el-switch ĐẦU TIÊN ngay sau nhãn "Variant Image".
 */
export const setVariantImageEnabled = async (page: any, enabled: boolean): Promise<void> => {
  const sw = page
    .locator('xpath=(//*[contains(text(),"Variant Image")]/following::*[contains(concat(" ",@class," ")," el-switch ")])[1]')
    .first();
  if ((await sw.count().catch(() => 0)) === 0) {
    console.warn('⚠️ Không thấy toggle "Variant Image" — bỏ qua.');
    return;
  }
  const isOn = await sw
    .evaluate((n: HTMLElement) => n.classList.contains("is-checked"))
    .catch(() => false);
  if (isOn !== enabled) {
    await sw.click();
    await page.waitForTimeout(600);
    console.log(`🔀 Toggle "Variant Image" → ${enabled ? "BẬT" : "TẮT"}`);
  } else {
    console.log(`🔀 Toggle "Variant Image" đã ${enabled ? "BẬT" : "TẮT"} sẵn.`);
  }
};

export const uploadVariantImages = async (
  page: any,
  variantImages: VariantImageParam[],
  remakeSeed?: string
): Promise<void> => {
  console.log("--- Bắt đầu Upload ảnh Variant (Bản Multi-Image US/DE/FR) ---");

  // TikTok/4Seller giới hạn 9 ảnh/variant → CAP 9, tránh "Exceeding the image count limit"
  //   (SHEIN có màu 10-11 ảnh). Cap ở đây để xử cả JSON cũ đã cào dư ảnh.
  const MAX_VARIANT_IMAGES = 9;
  const imageMap: { [key: string]: string[] } = {};
  for (const item of variantImages) {
    for (const [key, value] of Object.entries(item)) {
      const arr = Array.isArray(value) ? value : [value];
      if (arr.length > MAX_VARIANT_IMAGES) {
        console.log(`✂️ "${key}": ${arr.length} ảnh → cắt còn ${MAX_VARIANT_IMAGES} (giới hạn 4Seller)`);
      }
      imageMap[key] = arr.slice(0, MAX_VARIANT_IMAGES);
    }
  }

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(process.cwd(), `temp_variants_${uniqueId}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const failedColors: string[] = [];
  const usedBoxIdx = new Set<number>(); // box đã upload → KHÔNG tái dùng (chống chồng ảnh + match nhầm)

  for (const [colorName, imageUrls] of Object.entries(imageMap)) {
    const searchColor = colorName.trim();
    const localPaths: string[] = [];

    try {
      // 🐞 FIX lỗi "Green rỗng" + "Exceeding image count limit": KHÔNG match substring
      //   (vd /Green/i khớp cả "Army Green 2" → đẩy ảnh nhầm box, chồng >9 ảnh). Match nhãn
      //   màu CHÍNH XÁC (bỏ dấu "*" required), và bỏ qua box đã dùng.
      const boxes = page.locator([".variant_imgs li", ".variant_multiple_imgs .flex.column"].join(", "));
      const total = await boxes.count();
      const want = searchColor.toLowerCase();
      const labelsSeen: string[] = [];
      let targetBox: any = null;
      let targetIdx = -1;
      for (let bi = 0; bi < total; bi++) {
        if (usedBoxIdx.has(bi)) continue;
        const b = boxes.nth(bi);
        let label = (await b.locator(".line_ellipsis").first().innerText().catch(() => "")).trim();
        if (!label) label = ((await b.innerText().catch(() => "")) || "").trim().split("\n")[0];
        label = label.replace(/\s*\*\s*$/, "").trim(); // bỏ dấu "*" (required)
        labelsSeen.push(label);
        if (label.toLowerCase() === want) {
          targetBox = b;
          targetIdx = bi;
          break;
        }
      }

      if (!targetBox) {
        console.warn(`⚠️ Bỏ qua màu: "${searchColor}" (không thấy box khớp CHÍNH XÁC). UI còn:`, labelsSeen);
        continue;
      }
      usedBoxIdx.add(targetIdx);

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
