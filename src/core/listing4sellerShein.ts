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
import {
  fillDescription,
  generateDescriptionHtml,
  generateMeasureGuideHtml,
  selectDescriptionImages,
} from "./steps/fillDescription";
import { analyzeFitForSize, renderFitGuideHtml } from "../services/gemini/analyzeFitForSize";
import { generateRichDescription, composeRichHtml } from "../services/gemini/generateRichDescription";
import { buildBannerFile, buildTrustBannerFile, diverseImagesFromVariants } from "./steps/marketingBanner";
import { extractSizeChartSections, buildSizeGuideImageFile } from "./steps/sizeGuideImage";
import { processMeasureGuideImage } from "./steps/measureGuideImage";
import { uploadToImgbb, verifyImageUrl } from "../utils/uploadToImgbb";
import { uploadToImgbbCached } from "../utils/imgbbCache";
import { config as globalConfig } from "../config";
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
    // Thiếu file/thiếu shop = mọi tính năng BẬT. Đọc tươi mỗi listing → đổi là ăn ngay.
    const shopPrefs: Record<string, boolean> = (() => {
      try {
        const all = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "shop-listing.json"), "utf-8"));
        return all[targetProfile] ?? {};
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

    // Mô tả (port từ main): [Rich marketing bullets + banner AI] → [ảnh Size Guide gộp] → fallback text.
    // richDesc tắt theo shop → mô tả attributes đơn giản (không gọi Gemini).
    const [rich, fitGuide] = await Promise.all([
      prefOn("richDesc") ? generateRichDescription(data.product_name, data.attributes) : Promise.resolve(null),
      prefOn("sizeGuide") ? analyzeFitForSize(data.product_name, data.fit_reviews, data.size_chart) : Promise.resolve(null),
    ]);
    let richHtml = "";
    if (rich) {
      const bannerUrls: (string | null)[] = [];
      // Ảnh banner lấy ĐA MÀU (round-robin variant_images) → khoe nhiều màu. Fallback product_images.
      const diverse = diverseImagesFromVariants(data.variant_images);
      const bannerImgs = diverse.length >= 2 ? diverse : data.product_images;
      // Build banner + host imgbb (chỉ khi có IMGBB_API_KEY) → URL public chèn vào mô tả.
      if (globalConfig.imgbbApiKey) {
        for (const style of ["collage", "feature"] as const) {
          // Banner theo shop: collage (ảnh slide nhiều màu) / feature (hero + checkmark) bật tắt riêng.
          // Tắt → push null giữ đúng SLOT ([0]=collage, [1]=feature — composeRichHtml đọc theo vị trí).
          if (style === "collage" ? !prefOn("bannerCollage") : !prefOn("bannerFeature")) {
            bannerUrls.push(null);
            continue;
          }
          let bp: string | null = null;
          try {
            bp = await buildBannerFile(bannerImgs, style, rich.bannerTitle, rich.bannerTagline, rich.highlights);
            // Verify URL sống trước khi chèn — URL chết render thành khoảng trống trong mô tả.
            const bUrl = bp ? await uploadToImgbb(bp) : null;
            if (bUrl && !(await verifyImageUrl(bUrl))) {
              console.warn(`⚠️ banner ${style}: URL imgbb không serve được → bỏ slot (${bUrl})`);
              bannerUrls.push(null);
            } else {
              bannerUrls.push(bUrl);
            }
          } catch (e: any) {
            console.warn("⚠️ banner lỗi:", e?.message);
            bannerUrls.push(null);
          } finally {
            if (bp) { try { fs.unlinkSync(bp); } catch { /* ignore */ } }
          }
        }
      }
      richHtml = composeRichHtml(rich, bannerUrls, { heroFirst: workerConfig().descriptionHeroFirst === true });
    } else {
      // Gemini lỗi → fallback mô tả attributes cũ, không để mô tả rỗng.
      richHtml = generateDescriptionHtml(data.product_name, data.attributes, data.sizes_available, data.listing_variations?.colors || []);
    }

    // Ảnh GỘP Size Guide (size chart + How To Measure + Size Suggestion) → imgbb → chèn mô tả.
    let sizeGuideHtml = "";
    const guideSections = prefOn("sizeGuide") ? extractSizeChartSections(data.size_chart) : [];
    if (globalConfig.imgbbApiKey && guideSections.length > 0) {
      let gf: string | null = null;
      try {
        const mgImg = await processMeasureGuideImage(data.measure_guide?.image); // che watermark
        const mg = data.measure_guide ? { items: data.measure_guide.items, image: mgImg } : undefined;
        gf = await buildSizeGuideImageFile(guideSections, mg, data.size_chart?.unit || "inch", fitGuide || undefined);
        const url = gf ? await uploadToImgbb(gf) : null;
        if (url && (await verifyImageUrl(url))) {
          sizeGuideHtml =
            `<h3><strong>📏 Size Guide — Find Your Fit</strong></h3>` +
            `<figure class="image"><img src="${url}" alt="Size Guide"></figure>`;
        } else if (url) {
          console.warn(`⚠️ Size Guide: URL imgbb không serve được → fallback text (${url})`);
        }
      } catch (e: any) {
        console.warn("⚠️ ảnh Size Guide lỗi:", e?.message);
      } finally {
        if (gf) { try { fs.unlinkSync(gf); } catch { /* ignore */ } }
      }
    }
    // Fallback text nếu không tạo được ảnh (không có imgbb key / size_chart). Shop tắt sizeGuide → bỏ hẳn.
    if (!sizeGuideHtml && prefOn("sizeGuide")) {
      sizeGuideHtml =
        (fitGuide ? renderFitGuideHtml(fitGuide) : "") +
        generateMeasureGuideHtml(data.measure_guide ? { items: data.measure_guide.items, image: null } : undefined);
    }

    // Trust banner (shipping/quality/returns) — tĩnh → uploadToImgbbCached: 1 lần, sau đó cache hit.
    let trustHtml = "";
    if (globalConfig.imgbbApiKey && workerConfig().descriptionTrustBanner !== false) {
      let tf: string | null = null;
      try {
        tf = await buildTrustBannerFile();
        const tUrl = tf ? await uploadToImgbbCached(tf) : null;
        if (tUrl && (await verifyImageUrl(tUrl))) {
          trustHtml = `<figure class="image"><img src="${tUrl}" alt="Shop with confidence"></figure>`;
        }
      } catch (e: any) {
        console.warn("⚠️ trust banner lỗi (bỏ qua):", e?.message);
      } finally {
        if (tf) { try { fs.unlinkSync(tf); } catch { /* ignore */ } }
      }
    }

    // Ảnh sản phẩm chèn ở CUỐI mô tả, gộp vào 1 LẦN PASTE duy nhất → thứ tự cố định:
    // [text + banner AI] → [size guide] → [trust] → [📸 Details Up Close + ảnh variant].
    // (Trước đây paste ảnh riêng bằng Ctrl+End — cursor kẹt ở widget ảnh là chèn sai chỗ.)
    let descImagesHtml = "";
    if (data.variant_images && data.variant_images.length > 0) {
      const descImages = selectDescriptionImages(data.variant_images);
      console.log(`📸 Đã chọn ${descImages.length} ảnh cho mô tả từ ${data.variant_images.length} variants`);
      if (descImages.length) {
        descImagesHtml =
          `<h3><strong>📸 Details Up Close</strong></h3>` +
          descImages
            .map((u: string, i: number) => `<figure class="image"><img src="${u}" alt="Product image ${i + 1}"></figure>`)
            .join("");
      }
    }
    const descHtml = richHtml + sizeGuideHtml + trustHtml + descImagesHtml;
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

    // Dry-run + browser hiện: giữ mở 5 phút để user xem form đã điền (Ctrl+C để thoát sớm).
    if (!headless && opts?.dryRun) {
      console.log("🐛 [DRY-RUN] Giữ browser mở 5 phút để bạn kiểm tra form (không bấm Save)...");
      try { await page.waitForTimeout(300_000); } catch { /* page đóng tay → thôi */ }
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
