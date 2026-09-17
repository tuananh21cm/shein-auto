import fs from "fs";
import { workerConfig } from "../config/appConfig";
import { config as globalConfig } from "../config";
import { generateDescriptionHtml, generateMeasureGuideHtml, selectDescriptionImages } from "./steps/fillDescription";
import { analyzeFitForSize, renderFitGuideHtml } from "../services/gemini/analyzeFitForSize";
import { generateRichDescription, composeRichHtml } from "../services/gemini/generateRichDescription";
import { buildBannerFile, buildTrustBannerFile, diverseImagesFromVariants } from "./steps/marketingBanner";
import { extractSizeChartSections, buildSizeGuideImageFile } from "./steps/sizeGuideImage";
import { buildSizeChartHero, heroCandidates } from "./steps/sizeChartHero";
import { processMeasureGuideImage } from "./steps/measureGuideImage";
import { uploadToImgbb, verifyImageUrl } from "../utils/uploadToImgbb";
import { uploadToImgbbCached } from "../utils/imgbbCache";

export type RichDesc = Awaited<ReturnType<typeof generateRichDescription>>;

/**
 * Build HTML mô tả 4Seller (page-independent) — dùng chung cho Playwright + API:
 * [Rich marketing bullets + banner AI] → [ảnh Size Guide gộp] → [trust] → [📸 ảnh variant].
 * richDesc tắt theo shop → mô tả attributes đơn giản (không gọi AI).
 */
export const buildDescriptionHtml = async (
  data: any,
  prefOn: (k: string) => boolean
): Promise<{ descHtml: string; rich: RichDesc | null }> => {
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
        // Banner theo shop: collage / feature bật tắt riêng.
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
    // AI lỗi → fallback mô tả attributes cũ, không để mô tả rỗng.
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
      // LUÔN inch: `size_chart.unit` trong data không đáng tin (một số file ghi "cm" nhưng số
      // vẫn là inch) — xem ghi chú trong handleSizeChart.ts.
      // Hero: ảnh sản phẩm làm dải đầu ảnh; ảnh studio nền trắng sẽ tự bị loại → null → header đặc.
      const hero = await buildSizeChartHero(heroCandidates(data), { width: 1200, height: 215 });
      gf = await buildSizeGuideImageFile(guideSections, mg, "inch", fitGuide || undefined, hero);
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

  // Ảnh sản phẩm chèn ở CUỐI mô tả → thứ tự cố định: [text + banner] → [size guide] → [trust] → [📸 variant].
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
  return { descHtml: richHtml + sizeGuideHtml + trustHtml + descImagesHtml, rich };
};
