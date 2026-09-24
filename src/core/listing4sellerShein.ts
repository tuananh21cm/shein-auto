import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { configCookieForShop } from "../utils/configCookie";
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
import { fillSpecifics } from "./steps/fillSpecifics";
import { buildColorShowcaseImageFile } from "./steps/colorShowcase";
import { fillDescription, generateDescriptionHtml } from "./steps/fillDescription";
import { buildDescriptionHtml } from "./buildDescriptionHtml";
import { fillShippingAndCertification } from "./steps/fillShipping";
import { fillSourceUrl } from "./steps/fillSourceUrl";
import { fillSearchTermsAndHighlights } from "./steps/fillSearchHighlights";
import { handleSizeChartUpload } from "./steps/handleSizeChart";
import { detectPublishOutcome, checkPageErrors, captureScreenshot } from "./steps/publishAndDetect";
import { setOosVariantQuantity } from "./steps/removeUnavailableVariants";

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
  // Cookie resolve THEO SHOP (đa tài khoản 4Seller — shop thuộc account nào dùng cookie account đó,
  // port từ main). Fallback cookie legacy của user nếu shop không khớp account nào.
  const shopFolder = getProfileNameFromFolder(jsonFile);
  const cookie = await configCookieForShop(shopFolder, opts?.cookieUser ?? null);
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

  // 🕵️ CAPTURE API 4Seller (discovery: tìm endpoint upload ảnh + save listing để migrate sang API).
  // Bật bằng flag file data/capture-4seller-api.flag; ghi mọi POST/PUT /api/* + response → JSONL.
  const captureFlag = path.join(process.cwd(), "data", "capture-4seller-api.flag");
  if (fs.existsSync(captureFlag)) {
    const captureOut = path.join(process.cwd(), "data", "4seller-api-capture.jsonl");
    page.on("response", async (res) => {
      try {
        const r = res.request();
        const m = r.method();
        // Bắt: mọi /api/* của 4seller (kể cả GET → lộ attribute-schema/warehouse) + PUT lên COS (upload ảnh).
        const is4s = /4seller\.com\/api\//.test(r.url());
        const isCos = /meiyunji\.net|myqcloud\.com/.test(r.url()) && (m === "PUT" || m === "POST");
        if (!is4s && !isCos) return;
        const buf = r.postDataBuffer();
        const reqBody = r.postData() ?? (buf ? `<multipart ${buf.length} bytes>` : null);
        let respBody: string | null = null;
        try { respBody = (await res.text()).slice(0, 20000); } catch { /* binary/aborted */ }
        fs.appendFileSync(captureOut, JSON.stringify({
          t: new Date().toISOString(), method: m, url: r.url(),
          reqContentType: r.headers()["content-type"] || "",
          reqBody: reqBody ? String(reqBody).slice(0, 20000) : null,
          status: res.status(), respBody,
        }) + "\n");
      } catch { /* ignore */ }
    });
    console.log(`🕵️ [capture] ghi API 4Seller → ${captureOut}`);
  }

  try {
    console.log(`📄 Đọc file: ${jsonFile}`);
    if (!path.isAbsolute(jsonFile)) {
      throw new Error(
        `listing4sellerShein chỉ nhận absolute path. Nhận được: "${jsonFile}"`
      );
    }
    const jsonContent = await fs.promises.readFile(jsonFile, "utf-8");
    const data = JSON.parse(jsonContent);
    const targetProfile = getProfileNameFromFolder(jsonFile);
    // Cấu hình listing THEO SHOP (config/shop-listing.json — sửa qua Settings UI).
    // Shop chưa cấu hình riêng → ăn theo thẻ "__default" (mặc định chung). Thiếu cả 2 =
    // mọi tính năng BẬT. Đọc tươi mỗi listing → đổi là ăn ngay.
    const shopPrefs: Record<string, boolean> = (() => {
      try {
        const all = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "shop-listing.json"), "utf-8"));
        return all[targetProfile] ?? all["__default"] ?? {};
      } catch { return {}; }
    })();
    const prefOn = (k: string) => shopPrefs[k] !== false;
    if (Object.keys(shopPrefs).length) console.log(`⚙️ [${targetProfile}] shop-listing prefs:`, shopPrefs);

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
    // Brand resolve theo user (override) → fallback global brand-profiles.json
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
    // Tuỳ shop (Settings → card shop): TẮT "variantToMain" = KHÔNG trộn ảnh variant vào bộ
    // ảnh main — chỉ dùng ảnh gốc sản phẩm (+ showcase nếu bật).
    const productImagesForMain = prefOn("variantToMain")
      ? mergedProductImages
      : (data.product_images || []).slice(0, workerConfig().imageUploadMaxImages);
    if (!prefOn("variantToMain")) {
      console.log(`🖼️ [${targetProfile}] variantToMain=OFF → main dùng ${productImagesForMain.length} ảnh gốc (không trộn variant)`);
    }

    await fillVariations(page, data.listing_variations);
    await assertNoErrors(page, "fillVariations");

    await fillTableData(page, data.variant_price, data.attributes.SKU, 20, data.variant_ids, opts?.pricing);
    await assertNoErrors(page, "fillTableData");

    // Nếu tampermonkey gửi kèm available_matrix (mỗi màu có set size khác nhau),
    // dọn các (color, size) rows không available do 4Seller mặc định cross-product
    if (data.available_matrix && typeof data.available_matrix === "object") {
      await setOosVariantQuantity(page, data.available_matrix, data.oos_matrix);
      await assertNoErrors(page, "setOosVariantQuantity");
    }

    // Color showcase (opt-in): render 1 ảnh collage màu theo shop (bgSeed=targetProfile → mỗi
    // shop 1 kiểu, chống trùng ảnh Main khi list 1 sp lên nhiều shop). Ảnh phụ — lỗi thì bỏ qua.
    const showcaseCfg = workerConfig().colorShowcase;
    let showcaseFile: string | null = null;
    if (showcaseCfg?.enabled && prefOn("colorShowcase")) {
      try {
        showcaseFile = await buildColorShowcaseImageFile(
          data.product_images,
          data.variant_images,
          showcaseCfg.style ?? "B",
          { bgSeed: targetProfile }
        );
      } catch (e: any) {
        console.warn(`⚠️ color showcase lỗi, bỏ qua: ${e?.message ?? e}`);
      }
    }

    await uploadProductImages(page, productImagesForMain, showcaseFile ? [showcaseFile] : []);
    if (showcaseFile) fs.promises.unlink(showcaseFile).catch(() => {});
    await uploadVariantImages(page, data.variant_images);
    await assertNoErrors(page, "uploadImages");

    await handleBrand(page, data.brand_name);

    // Điền Specifics (Optional): map SHEIN attributes → dropdown 4Seller. Mặc định TẮT —
    // bật "fillSpecifics": true trong config/worker.json sau khi verify trên 4Seller.
    if (workerConfig().fillSpecifics) {
      await fillSpecifics(page, data.attributes || {});
      await assertNoErrors(page, "fillSpecifics");
    }

    // Mô tả: helper dùng chung với đường API (src/core/buildDescriptionHtml.ts).
    const { descHtml, rich } = await buildDescriptionHtml(data, prefOn);
    await fillDescription(page, descHtml);

    // 2 field TikTok mới: Search terms (backend keywords) + Product highlights — AI sinh kèm rich desc
    if (rich) {
      await fillSearchTermsAndHighlights(page, rich.searchTerms, rich.productHighlights);
    }

    await fillShippingAndCertification(page);
    await handleSizeChartUpload(page, { size_chart: data.size_chart });
    await assertNoErrors(page, "fillShipping+sizeChart");

    // Điền Source URL vào mục "4Seller set" (metadata nội bộ 4Seller, KHÔNG lên TikTok)
    await fillSourceUrl(page, data.url);
    await page.waitForTimeout(3000);

    // Click Save & Publish + detect outcome
    const outcome = await detectPublishOutcome(page, { dryRun: opts?.dryRun });
    console.log(`📊 Publish outcome:`, outcome);

    if (!outcome.ok) {
      const screenshot = outcome.screenshotPath ? `\nScreenshot: ${outcome.screenshotPath}` : "";
      throw new Error(`Publish thất bại: ${outcome.reason}${screenshot}`);
    }

    console.log(`✅ Hoàn thành đăng sản phẩm. ${outcome.reason}`);

    // Dry-run + browser hiện: giữ mở để user xem form đã điền (Ctrl+C để thoát sớm).
    // Số phút cấu hình qua env DRYRUN_HOLD_MIN (mặc định 5).
    if (!headless && opts?.dryRun) {
      const mins = Math.max(1, Math.min(30, Number(process.env.DRYRUN_HOLD_MIN) || 5));
      console.log(`🐛 [DRY-RUN] Giữ browser mở ${mins} phút để bạn kiểm tra form (không bấm Save)...`);
      try { await page.waitForTimeout(mins * 60_000); } catch { /* page đóng tay → thôi */ }
    }
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
