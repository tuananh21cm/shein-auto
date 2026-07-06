import fs from "fs";
import { chromium } from "playwright-core";
import { configCookieForShop } from "../utils/configCookie";
import { genTitleFromShein } from "../services/gemini/genTitleFromShein";
import { generatePodTitle } from "../services/gemini/generatePodTitle";
import { analyzeFitForSize, renderFitGuideHtml } from "../services/gemini/analyzeFitForSize";
import { processMeasureGuideImage } from "./steps/measureGuideImage";
import { generateRichDescription, composeRichHtml } from "../services/gemini/generateRichDescription";
import { buildBannerFile, buildTrustBannerFile, diverseImagesFromVariants } from "./steps/marketingBanner";
import { uploadToImgbb, verifyImageUrl } from "../utils/uploadToImgbb";
import { uploadToImgbbCached } from "../utils/imgbbCache";
import { config } from "../config";
import { cleanTitle, toTitleCase } from "../utils/cleanTitle";
import { workerConfig } from "../config/appConfig";
import { resolveBrandForUser } from "../state/userDirs";

import { getProfileNameFromFolder, normalizeShopName } from "./steps/randomUtils";
import { findCategory } from "./steps/findCategory";
import { preprocessData } from "./steps/preprocessData";
import { selectProfile, selectCategory } from "./steps/selectProfile";
import { fillVariations } from "./steps/fillVariations";
import { fillTableData } from "./steps/fillTableData";
import { uploadProductImages, uploadVariantImages, setVariantImageEnabled } from "./steps/uploadImages";
import { handleBrand } from "./steps/handleBrand";
import {
  cleanupEditorHtml,
  fillDescription,
  generateDescriptionHtml,
  generateMeasureGuideHtml,
  selectDescriptionImages,
  uploadDescriptionImages,
} from "./steps/fillDescription";
import { fillSpecifics } from "./steps/fillSpecifics";
import { fillShippingAndCertification } from "./steps/fillShipping";
import {
  handleSizeChartUpload,
  extractSizeChartSections,
  buildSizeGuideImageFile,
} from "./steps/handleSizeChart";
import { buildColorShowcaseImageFile } from "./steps/colorShowcase";
import { detectPublishOutcome, checkPageErrors, captureScreenshot } from "./steps/publishAndDetect";
import { removeUnavailableVariants } from "./steps/removeUnavailableVariants";

export { findCategory, handleBrand, fillVariations, fillTableData };
export { uploadProductImages, uploadVariantImages };
export { fillDescription, generateDescriptionHtml };

/**
 * Bật radio "Has Variations". Ngay sau selectCategory, ô hiển thị category (class
 * `.line_ellipsis`) hoặc overlay popup xác nhận có thể còn ĐÈ lên radio → click bị
 * "element intercepts pointer events" và timeout 30s. Xử lý:
 *   1. Chờ mọi overlay Element Plus (message-box / dialog wrapper) ẩn.
 *   2. Nếu radio đã bật rồi (do click category trước lỡ toggle) → bỏ qua.
 *   3. Click vào cả LABEL `.el-radio` (vùng click lớn, chuẩn Element Plus), retry,
 *      cuối cùng force nếu vẫn bị chặn.
 */
const clickHasVariations = async (page: any): Promise<void> => {
  // 1. Đợi overlay tan (message-box của selectCategory, v.v.)
  for (const sel of [".el-message-box__wrapper", ".el-overlay", ".el-loading-mask"]) {
    await page
      .locator(sel)
      .first()
      .waitFor({ state: "hidden", timeout: 4000 })
      .catch(() => {});
  }

  // Ưu tiên click cả label .el-radio (Element Plus: click label = chọn radio).
  const radio = page.locator(".el-radio", { hasText: "Has Variations" }).first();
  const fallback = page.locator("span.el-radio__label", { hasText: "Has Variations" }).first();
  const target = (await radio.count()) > 0 ? radio : fallback;

  await target.waitFor({ state: "visible", timeout: 10000 });

  // 2. Đã bật sẵn? (label cha có is-checked) → khỏi click.
  const already = await target
    .evaluate((el: HTMLElement) => {
      const r = el.closest(".el-radio") ?? el;
      return r.classList.contains("is-checked");
    })
    .catch(() => false);
  if (already) {
    console.log("ℹ️ 'Has Variations' đã bật sẵn, bỏ qua click.");
    return;
  }

  // 3. Thử click thường (timeout ngắn để fail nhanh), rồi force.
  await target.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await target.click({ timeout: 8000 });
  } catch {
    console.warn("⚠️ 'Has Variations' bị element khác chặn click → thử lại sau khi cuộn + force.");
    await page.waitForTimeout(600);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 8000, force: true });
  }
};

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
  // Cookie load THEO SHOP (đa tài khoản 4Seller): shop thuộc tài khoản nào dùng
  // cookie tài khoản đó. Fallback cookie legacy theo user khi chưa setup tài khoản.
  const targetProfileEarly = getProfileNameFromFolder(jsonFile);
  const cookie = await configCookieForShop(targetProfileEarly, opts?.cookieUser ?? null);
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
    // POD: giữ key chính (tên file) + AI mix key t-shirt. Thường: viết lại toàn bộ title.
    const titlePromise = data._pod
      ? generatePodTitle(data.product_name)
      : genTitleFromShein(data.product_name);
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
    // POD: KHÔNG prepend brand/shop name vào title (giữ nguyên title AI). Thường: ghép brand đầu title.
    // Title Case: viết hoa ký tự đầu mỗi từ trước khi list lên 4Seller.
    const finalTitle = toTitleCase(data._pod ? String(aiTitle).trim() : cleanTitle(aiTitle, brand));
    // Fail-fast: Gemini lỗi trả title rỗng + shop không có brand → điền title rỗng
    // → chết mãi tận lúc publish với "Can not be empty" mù mờ. Throw sớm cho rõ.
    if (!finalTitle) {
      throw new Error(
        `Title rỗng (Gemini không trả được title cho "${data.product_name}", brand="${brand}") — dừng trước khi fill form`
      );
    }
    console.log(finalTitle);
    await page.fill("#productInfo .el-input.mr_8 .el-input__inner", finalTitle);
    await page.waitForTimeout(2000);

    // Category (AI mapping) — đã promise xong
    const categoryPath = await categoryPromise;
    await selectCategory(page, categoryPath);
    await assertNoErrors(page, "selectCategory");

    await clickHasVariations(page);
    await page.waitForTimeout(2000);

    // Pre-process: size normalize, dedup, filter, merge product images
    const { mergedProductImages } = preprocessData(data);

    await fillVariations(page, data.listing_variations);
    await assertNoErrors(page, "fillVariations");

    // POD: giá CUỐI cố định → bỏ qua công thức (price+ship)*mult+extra bằng override identity.
    const priceOverride =
      data._pod && data._podPriceFinal ? { shipFee: 0, multiplier: 1, extraAdd: 0 } : opts?.pricing;
    // POD: SKU = TA-ddmm-{shopname} (vd TA-1606-AESS). shopSuffix="" để không append lần 2.
    // shopname = brand code (vd AESS); chưa map brand thì fallback tên folder shop.
    const shopCode = normalizeShopName(brand) || normalizeShopName(targetProfile);
    let skuValue = data.attributes.SKU;
    let skuSuffix = shopCode;
    if (data._pod) {
      const n = new Date();
      const ddmm = `${String(n.getDate()).padStart(2, "0")}${String(n.getMonth() + 1).padStart(2, "0")}`;
      skuValue = `TA-${ddmm}-${shopCode}`;
      skuSuffix = "";
    }
    await fillTableData(
      page,
      data.variant_price,
      skuValue,
      5,
      data.variant_ids,
      priceOverride,
      skuSuffix,
      data._pod ? data._podSizeSurcharge : undefined // POD: phụ giá theo size (XXL+2, 3XL+4)
    );
    await assertNoErrors(page, "fillTableData");

    // Nếu tampermonkey gửi kèm available_matrix (mỗi màu có set size khác nhau),
    // dọn các (color, size) rows không available do 4Seller mặc định cross-product
    if (data.available_matrix && typeof data.available_matrix === "object") {
      await removeUnavailableVariants(page, data.available_matrix);
      await assertNoErrors(page, "removeUnavailableVariants");
    }

    // Ảnh GỘP Size Guide giờ chèn vào MÔ TẢ (ảnh đầu), không còn vào gallery.
    // Ảnh "nhiều màu" làm ảnh main (nếu bật + sản phẩm có ≥2 màu).
    // MD5 unique theo TỪNG listing: seed remake = shop + salt từ tên file JSON (unique mỗi
    // listing, ổn định khi chạy lại cùng file). Ảnh tái dùng (material POD / nguồn SHEIN chung)
    // ra MD5 KHÁC nhau mỗi listing → tránh bị TikTok quét trùng ảnh.
    const remakeSalt = (jsonFile.split(/[\\/]/).pop() || "rnd").replace(/\.json$/i, "");
    const remakeSeed = `${targetProfile}:${remakeSalt}`;

    let colorShowcasePath: string | null = null;
    const csCfg = workerConfig().colorShowcase;
    if (csCfg?.enabled && !data._pod) {
      // POD: mọi màu chung 1 ảnh → collage nhiều màu vô nghĩa, skip.
      // bgSeed theo shop → ảnh NỀN collage xoay màu khác nhau giữa các shop (cùng 1 sp).
      try {
        colorShowcasePath = await buildColorShowcaseImageFile(
          data.product_images,
          data.variant_images,
          csCfg.style || "C",
          { bgSeed: remakeSeed }
        );
      } catch (e: any) {
        console.warn("⚠️ Không tạo được ảnh nhiều màu:", e?.message);
      }
    }
    await uploadProductImages(page, mergedProductImages, remakeSeed, {
      prependLocalPath: colorShowcasePath,
    });
    if (colorShowcasePath) {
      try {
        fs.unlinkSync(colorShowcasePath);
      } catch {
        /* ignore */
      }
    }
    if (data._pod) {
      // POD: 1 ảnh design dùng chung → TẮT toggle "Variant Image", không điền ảnh từng màu.
      await setVariantImageEnabled(page, false);
    } else {
      await uploadVariantImages(page, data.variant_images, remakeSeed);
    }
    await assertNoErrors(page, "uploadImages");

    await handleBrand(page, data.brand_name);

    // Điền Specifics (Optional): map SHEIN attributes → dropdown 4Seller. Mặc định TẮT —
    // bật bằng "fillSpecifics": true trong config/worker.json sau khi verify trên 4Seller.
    if (workerConfig().fillSpecifics) {
      await fillSpecifics(page, data.attributes || {});
    }

    // Mô tả: [Rich marketing bullets + banner đan xen] → [Size Recommendation] → [How To Measure].
    const [rich, fitGuide] = await Promise.all([
      generateRichDescription(data.product_name, data.attributes),
      analyzeFitForSize(data.product_name, data.fit_reviews, data.size_chart),
    ]);
    let richHtml = "";
    if (rich) {
      const bannerUrls: (string | null)[] = [];
      // Ảnh banner lấy ĐA MÀU (round-robin variant_images) → khoe nhiều màu. Fallback product_images.
      const diverse = diverseImagesFromVariants(data.variant_images);
      const bannerImgs = diverse.length >= 2 ? diverse : data.product_images;
      // Build banner + host imgbb (chỉ khi có IMGBB_API_KEY) → URL public chèn vào mô tả.
      if (config.imgbbApiKey) {
        for (const style of ["collage", "feature"] as const) {
          let bp: string | null = null;
          try {
            bp = await buildBannerFile(
              bannerImgs,
              style,
              rich.bannerTitle,
              rich.bannerTagline,
              rich.highlights
            );
            // Verify URL sống trước khi chèn — URL chết render thành khoảng trống trong mô tả.
            const bUrl = bp ? await uploadToImgbb(bp) : null;
            if (bUrl && !(await verifyImageUrl(bUrl))) {
              console.warn(`⚠️ banner ${style}: URL imgbb không serve được ảnh → bỏ slot banner này (${bUrl})`);
              bannerUrls.push(null);
            } else {
              bannerUrls.push(bUrl);
            }
          } catch (e: any) {
            console.warn("⚠️ banner lỗi:", e?.message);
            bannerUrls.push(null);
          } finally {
            if (bp) {
              try {
                fs.unlinkSync(bp);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      richHtml = composeRichHtml(rich, bannerUrls, {
        heroFirst: workerConfig().descriptionHeroFirst === true,
      });
    }
    // Ảnh GỘP Size Guide (size chart + How To Measure + Size Suggestion) → imgbb → chèn mô tả.
    let sizeGuideHtml = "";
    const guideSections = extractSizeChartSections(data.size_chart);
    if (config.imgbbApiKey && guideSections.length > 0) {
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
          console.warn(`⚠️ Size Guide: URL imgbb không serve được ảnh → dùng fallback text (${url})`);
        }
      } catch (e: any) {
        console.warn("⚠️ ảnh Size Guide lỗi:", e?.message);
      } finally {
        if (gf) {
          try {
            fs.unlinkSync(gf);
          } catch {
            /* ignore */
          }
        }
      }
    }
    // Fallback text nếu không tạo được ảnh (không có imgbb key / size_chart).
    if (!sizeGuideHtml) {
      sizeGuideHtml =
        (fitGuide ? renderFitGuideHtml(fitGuide) : "") +
        generateMeasureGuideHtml(
          data.measure_guide ? { items: data.measure_guide.items, image: null } : undefined
        );
    }
    // POD: chèn template mô tả cố định lên đầu (trước rich/banner AI).
    if (data._pod && data._podDescriptionTemplate) {
      richHtml = data._podDescriptionTemplate + richHtml;
    }
    const descHtml = richHtml + sizeGuideHtml;
    await fillDescription(page, descHtml);

    // Trust banner (shipping/quality/returns) chèn CUỐI mô tả — tĩnh, không phụ thuộc
    // sản phẩm → uploadToImgbbCached: chỉ upload 1 lần, các listing sau cache hit.
    let trustHtml = "";
    if (config.imgbbApiKey && workerConfig().descriptionTrustBanner !== false) {
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
        if (tf) {
          try {
            fs.unlinkSync(tf);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const descImagesHeading = `<h3><strong>📸 Details Up Close</strong></h3>`;
    if (data._pod) {
      // POD: chỉ có 1 ảnh gốc → mô tả chỉ cần đúng ảnh design đó.
      const designImg = (data.product_images || [])[0];
      if (designImg) {
        console.log(`📸 POD: dùng 1 ảnh design cho mô tả`);
        await uploadDescriptionImages(page, [designImg], {
          headingHtml: descImagesHeading,
          trailingHtml: trustHtml,
        });
      } else if (trustHtml) {
        await uploadDescriptionImages(page, [], { trailingHtml: trustHtml });
      }
    } else if (data.variant_images && data.variant_images.length > 0) {
      const descImages = selectDescriptionImages(data.variant_images);
      console.log(`📸 Đã chọn ${descImages.length} ảnh cho mô tả từ ${data.variant_images.length} variants`);
      await uploadDescriptionImages(page, descImages, {
        headingHtml: descImagesHeading,
        trailingHtml: trustHtml,
      });
    } else if (trustHtml) {
      await uploadDescriptionImages(page, [], { trailingHtml: trustHtml });
    }
    // Lưới an toàn cuối cho mô tả: bỏ figure mất ảnh + gộp dòng trống thừa.
    await cleanupEditorHtml(page);

    await fillShippingAndCertification(page);
    await handleSizeChartUpload(page, { size_chart: data.size_chart });
    await assertNoErrors(page, "fillShipping+sizeChart");

    // KHÔNG điền URL Shein gốc — tránh TikTok detect nguồn dropshipping.
    await page.waitForTimeout(3000);

    // Click Save & Publish (hoặc Save/lưu nháp nếu saveDraftOnly) + detect outcome
    const saveDraft = workerConfig().saveDraftOnly === true;
    if (saveDraft) console.log("📝 saveDraftOnly=true → sẽ click Save (lưu NHÁP), không đăng live");
    const outcome = await detectPublishOutcome(page, { dryRun: opts?.dryRun, saveDraft });
    console.log(`📊 Publish outcome:`, outcome);

    if (!outcome.ok) {
      const screenshot = outcome.screenshotPath ? `\nScreenshot: ${outcome.screenshotPath}` : "";
      throw new Error(`Publish thất bại: ${outcome.reason}${screenshot}`);
    }

    console.log(`✅ Hoàn thành đăng sản phẩm. ${outcome.reason}`);

    // Dry-run + headed: giữ browser mở 200s để check tay (mô tả, Specifics, ảnh...).
    if (opts?.dryRun && !headless) {
      console.log("🐛 [DEBUG] Dry-run xong → giữ browser mở 200s để bạn check manual...");
      await page.waitForTimeout(200_000).catch(() => {});
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
