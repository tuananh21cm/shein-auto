import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { safeCleanupDir } from "./cleanupTemp";
import { workerConfig } from "../../config/appConfig";

interface VariantImageParam {
  [color: string]: string | string[];
}

// Lỗi mạng tạm thời từ CDN (reset/treo/DNS) → đáng retry. 404/403... thì không.
const isTransientNetErr = (err: any): boolean => {
  const code = err?.code ?? "";
  const msg: string = err?.message ?? "";
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "ECONNREFUSED"].includes(code) ||
    /ECONNRESET|ETIMEDOUT|socket hang up|timeout|network|aborted/i.test(msg)
  );
};

// Tải 1 lần: stream về file, bắt lỗi cả ở response lẫn GIỮA CHỪNG stream (socket reset).
const downloadOnce = async (url: string, filePath: string): Promise<void> => {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 30_000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const writer = fs.createWriteStream(filePath);
  await new Promise<void>((resolve, reject) => {
    // Lỗi ECONNRESET khi đang stream phát ra ở response.data, không phải writer.
    response.data.on("error", (err: any) => {
      writer.destroy();
      reject(err);
    });
    writer.on("error", (err) => {
      writer.destroy();
      reject(err);
    });
    writer.on("finish", () => resolve());
    response.data.pipe(writer);
  });
};

const downloadToFile = async (url: string, filePath: string, maxRetries = 3): Promise<void> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Mỗi lần thử ghi đè sạch (xoá file dở của lần trước nếu có).
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      await downloadOnce(url, filePath);
      return;
    } catch (err: any) {
      if (attempt === maxRetries || !isTransientNetErr(err)) {
        throw new Error(`Tải ảnh thất bại (${err?.code ?? err?.message}) sau ${attempt} lần: ${url}`);
      }
      const delay = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(
        `⚠️ Tải ảnh lỗi (${err?.code ?? err?.message}) — retry ${attempt}/${maxRetries - 1} sau ${delay}ms: ${url}`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

export const uploadProductImages = async (
  page: any,
  imageUrls: string[],
  prependFiles: string[] = []
): Promise<void> => {
  console.log("--- Bắt đầu quy trình Upload Ảnh (Bản an toàn đa luồng) ---");

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(__dirname, `temp_images_${uniqueId}`);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  try {
    // Download song song — tăng tốc N lần so với for-await sequential
    const t0 = Date.now();
    const downloaded = await Promise.all(
      imageUrls.map(async (url, i) => {
        const filePath = path.join(tempDir, `img_${i}.jpg`);
        await downloadToFile(url, filePath);
        return filePath;
      })
    );
    // prependFiles = ảnh LOCAL đã render sẵn (vd color showcase) → đứng ĐẦU làm ảnh Main.
    // CAP tổng tại imageUploadMaxImages: showcase chiếm 1 slot thì bỏ ảnh CUỐI, không để tràn
    // (TikTok/4Seller báo "exceed the limit image count" nếu quá 9).
    const maxImgs = workerConfig().imageUploadMaxImages || 9;
    const localFilePaths = [...prependFiles.filter((f) => fs.existsSync(f)), ...downloaded].slice(0, maxImgs);
    if (prependFiles.length && downloaded.length + prependFiles.length > maxImgs) {
      console.log(`🖼️ Cap ảnh: ${prependFiles.length} showcase + ${downloaded.length} sp → giữ ${localFilePaths.length}/${maxImgs}`);
    }
    console.log(`⬇️ [${uniqueId}] Download ${imageUrls.length} ảnh song song mất ${Math.round((Date.now() - t0) / 1000)}s`);

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

// Universal selector cho 1 ô variant-image (US cũ + DE/FR mới)
const VARIANT_BOX_SELECTOR = [".variant_imgs li", ".variant_multiple_imgs .flex.column"].join(", ");

// Escape ký tự đặc biệt để dùng tên màu trong RegExp an toàn (vd "Red (Bright)")
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const uploadVariantImages = async (
  page: any,
  variantImages: VariantImageParam[]
): Promise<void> => {
  console.log("--- Bắt đầu Upload ảnh Variant (Bản Multi-Image US/DE/FR) ---");

  // Multi-image per variant (như main): tối đa 9 ảnh/màu — 4Seller giới hạn 9,
  // SHEIN có màu 10-11 ảnh nên phải cap tránh "Exceeding the image count limit".
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
  const colorCount = Object.keys(imageMap).length;

  // Readiness gate: đợi vùng Variant Image render ĐỦ số màu + ổn định ~1.5s trước
  // khi khớp màu. Sửa gốc lỗi "màu đầu tiên khớp quá sớm → count 0 → bỏ sót".
  {
    const tReady = Date.now();
    const maxReady = 15_000;
    const stableReadyMs = 1_500;
    let lastN = -1;
    let lastChange = Date.now();
    while (Date.now() - tReady < maxReady) {
      const n = await page.locator(VARIANT_BOX_SELECTOR).count();
      if (n !== lastN) { lastN = n; lastChange = Date.now(); }
      if (n >= colorCount && Date.now() - lastChange > stableReadyMs) break;
      await page.waitForTimeout(300);
    }
    console.log(`🧩 Variant image section sẵn sàng: ${lastN}/${colorCount} ô (sau ${Math.round((Date.now() - tReady) / 1000)}s)`);
  }

  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempDir = path.join(process.cwd(), `temp_variants_${uniqueId}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const failedColors: string[] = [];

  for (const [colorName, imageUrls] of Object.entries(imageMap)) {
    const searchColor = colorName.trim();
    const localPaths: string[] = [];

    try {
      const variantContainer = page
        .locator(VARIANT_BOX_SELECTOR)
        .filter({ hasText: new RegExp(escapeRegExp(searchColor), "i") });

      // Retry khớp container: vùng có thể re-layout sau mỗi lần upload màu trước.
      let count = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        count = await variantContainer.count();
        if (count > 0) break;
        await page.waitForTimeout(1000);
      }

      if (count === 0) {
        const currentUIColors = await page
          .locator(".variant_imgs .line_ellipsis, .variant_multiple_imgs .flex.column")
          .allInnerTexts();
        console.error(`❌ Không tìm thấy ô variant cho màu: "${searchColor}". UI hiện có:`, currentUIColors);
        failedColors.push(searchColor);
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
          return localPath;
        })
      );
      localPaths.push(...downloaded);
      console.log(`⬇️ Variant "${searchColor}": download ${imageUrls.length} ảnh mất ${Math.round((Date.now() - tDl) / 1000)}s`);

      // Chọn ĐÚNG ô lá của màu: trong các container khớp hasText, lấy cái có ĐÚNG
      // 1 input upload. Tránh bắt nhầm container CHA bọc nhiều màu (text cha chứa
      // mọi tên màu → hasText khớp, .first() ra cha → nhiều input → setInputFiles
      // lỗi strict-mode → mọi màu fail). Ưu tiên leaf có nhãn trùng khớp tên màu.
      const norm = (t: string) => t.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const matchN = await variantContainer.count();
      const leaves: { box: any; label: string }[] = [];
      for (let i = 0; i < matchN; i++) {
        const box = variantContainer.nth(i);
        if ((await box.locator("input.file_upload__input").count()) !== 1) continue; // bỏ container cha
        leaves.push({ box, label: norm(await box.innerText().catch(() => "")) });
      }
      const targetBox =
        leaves.find((l) => l.label === searchColor.toLowerCase())?.box ?? leaves[0]?.box ?? null;
      if (!targetBox) {
        console.error(`❌ "${searchColor}": không có ô lá (1 input) trong ${matchN} container khớp.`);
        failedColors.push(searchColor);
        continue;
      }
      console.log(`🎯 "${searchColor}": ${matchN} container khớp, ${leaves.length} ô lá → chọn 1.`);
      await targetBox.scrollIntoViewIfNeeded();

      const fileInput = targetBox.locator("input.file_upload__input").first();
      await fileInput.waitFor({ state: "attached" });

      const imgsBefore = await targetBox.locator("img").count();
      const expected = imgsBefore + localPaths.length;

      // Set files + smart-wait; nếu không có ảnh nào được thêm → thử lại 1 lần nữa.
      let last = imgsBefore;
      for (let tryUpload = 0; tryUpload < 2; tryUpload++) {
        await fileInput.setInputFiles(localPaths);
        const tUp = Date.now();
        const maxWait = 30_000;
        const stable = 2_000;
        last = await targetBox.locator("img").count();
        let lastChange = Date.now();
        while (Date.now() - tUp < maxWait) {
          const c = await targetBox.locator("img").count();
          if (c !== last) { last = c; lastChange = Date.now(); }
          if (c >= expected) break;
          if (c > imgsBefore && Date.now() - lastChange > stable) break;
          await page.waitForTimeout(400);
        }
        if (last > imgsBefore) break; // đã có ảnh → xong
        console.warn(`⚠️ "${searchColor}": chưa có ảnh nào sau lần thử ${tryUpload + 1}, retry...`);
        await page.waitForTimeout(800);
      }

      if (last <= imgsBefore) {
        console.error(`❌ "${searchColor}": upload xong nhưng KHÔNG có ảnh nào (${imgsBefore}→${last}).`);
        failedColors.push(searchColor);
        continue;
      }
      console.log(`✅ "${searchColor}": ${localPaths.length} ảnh upload (${imgsBefore}→${last}).`);
    } catch (innerError) {
      console.error(`❌ Lỗi tại màu ${searchColor}:`, innerError);
      failedColors.push(searchColor);
      continue;
    }
  }

  safeCleanupDir(tempDir, `variant_${uniqueId}`);

  if (failedColors.length > 0) {
    // DEBUG: dump cấu trúc DOM thật của vùng variant-image để khớp selector chính xác.
    try {
      const counts = await page.evaluate(() => {
        const n = (s: string) => document.querySelectorAll(s).length;
        return {
          ".variant_imgs": n(".variant_imgs"),
          ".variant_imgs li": n(".variant_imgs li"),
          ".variant_multiple_imgs": n(".variant_multiple_imgs"),
          ".variant_multiple_imgs .flex.column": n(".variant_multiple_imgs .flex.column"),
          "input.file_upload__input": n("input.file_upload__input"),
          ".file_upload__index": n(".file_upload__index"),
        };
      });
      console.error("🔎 [variant-debug] selector counts:", JSON.stringify(counts));
      const dbgPath = path.join(process.cwd(), "data", `debug-variant-${Date.now()}.html`);
      fs.writeFileSync(dbgPath, await page.content());
      console.error(`🔎 [variant-debug] đã dump HTML trang vào: ${dbgPath}`);
    } catch (e: any) {
      console.error("🔎 [variant-debug] dump lỗi:", e?.message ?? e);
    }
    throw new Error(
      `Upload variant images thất bại cho ${failedColors.length} màu: ${failedColors.join(", ")}`
    );
  }
  console.log("--- Hoàn tất chu kỳ upload ảnh Variant ---");
};
