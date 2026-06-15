import { sizeMap, workerConfig } from "../../config/appConfig";

interface VariantImageParam {
  [color: string]: string | string[];
}

const normalizeSize = (s: string): string => sizeMap()[s.toLowerCase().trim()] ?? s;

/**
 * Pre-process JSON data trước khi đẩy lên 4Seller:
 *  - Normalize size sang chuẩn TikTok US (XS/S/M/L/XL...)
 *  - Dedup variants có cùng bộ ảnh (tránh "misleading listing")
 *  - Lọc bỏ màu không có ảnh
 *  - Gộp product_images với hero shot từ mỗi variant (tăng CTR)
 *
 * Trả về object data đã mutate + mergedProductImages.
 */
export const preprocessData = (data: any): { mergedProductImages: string[] } => {
  // 1. SIZE NORMALIZATION
  if (data.listing_variations?.sizes) {
    const before = [...data.listing_variations.sizes];
    data.listing_variations.sizes = data.listing_variations.sizes.map(normalizeSize);
    data.sizes_available = (data.sizes_available || []).map(normalizeSize);
    console.log(`📐 Size normalized: ${before.join(", ")} → ${data.listing_variations.sizes.join(", ")}`);
  }

  // Quan trọng: cũng phải normalize size trong available_matrix vì
  // 4Seller bảng dùng size đã normalized (S/M/L) — nếu matrix còn raw
  // "4 (S)" thì removeUnavailableVariants sẽ xoá NHẦM hết variants.
  if (data.available_matrix && typeof data.available_matrix === "object") {
    const normalized: Record<string, string[]> = {};
    for (const [color, sizes] of Object.entries(data.available_matrix)) {
      const sizeArr = Array.isArray(sizes) ? sizes : [];
      normalized[color] = sizeArr.map((s) => normalizeSize(String(s)));
    }
    data.available_matrix = normalized;
    console.log(`📐 Matrix sizes normalized:`, normalized);
  }

  // Normalize oos_matrix tương tự available_matrix
  if (data.oos_matrix && typeof data.oos_matrix === "object") {
    const normalized: Record<string, string[]> = {};
    for (const [color, sizes] of Object.entries(data.oos_matrix)) {
      const sizeArr = Array.isArray(sizes) ? sizes : [];
      normalized[color] = sizeArr.map((s) => normalizeSize(String(s)));
    }
    data.oos_matrix = normalized;
    console.log(`📐 OOS matrix sizes normalized:`, normalized);
  }

  // 2. VARIANT IMAGE DEDUP
  if (data.variant_images && data.variant_images.length > 0) {
    const imageSignatureMap = new Map<string, string>();
    const deduped: VariantImageParam[] = [];
    const removedColors = new Set<string>();

    for (const item of data.variant_images) {
      for (const [colorName, urls] of Object.entries(item)) {
        const urlList = Array.isArray(urls) ? urls : [urls as string];
        const signature = urlList.slice().sort().join("|");

        if (imageSignatureMap.has(signature)) {
          const primaryColor = imageSignatureMap.get(signature)!;
          console.log(`🔁 Dedup: "${colorName}" có cùng ảnh với "${primaryColor}" → bỏ qua`);
          removedColors.add(colorName);
        } else {
          imageSignatureMap.set(signature, colorName);
          deduped.push({ [colorName]: urlList });
        }
      }
    }

    if (removedColors.size > 0) {
      data.variant_images = deduped;
      if (data.listing_variations?.colors) {
        data.listing_variations.colors = data.listing_variations.colors.filter(
          (c: string) => !removedColors.has(c)
        );
      }
      if (data.variant_price) {
        data.variant_price = data.variant_price.filter(
          (p: any) => !Object.keys(p).some((k) => removedColors.has(k))
        );
      }
      console.log(`✅ Dedup xong: còn ${data.variant_images.length} variant (bỏ ${removedColors.size} trùng ảnh)`);
    }
  }

  // 2b. FILTER COLORS WITHOUT IMAGES
  if (data.variant_images && data.variant_images.length > 0 && data.listing_variations?.colors) {
    const colorsWithImages = new Set<string>(
      data.variant_images.map((item: VariantImageParam) => Object.keys(item)[0])
    );
    const originalColors: string[] = data.listing_variations.colors;
    const filteredColors = originalColors.filter((c: string) => colorsWithImages.has(c));
    const missingImageColors = originalColors.filter((c: string) => !colorsWithImages.has(c));

    if (missingImageColors.length > 0) {
      console.log(`⚠️ Bỏ ${missingImageColors.length} màu không có ảnh: ${missingImageColors.join(", ")}`);
      data.listing_variations.colors = filteredColors;
      if (data.variant_price) {
        data.variant_price = data.variant_price.filter(
          (p: any) => !Object.keys(p).some((k: string) => missingImageColors.includes(k))
        );
      }
    }
  }

  // 3. MERGE PRODUCT IMAGES với hero shot từ mỗi variant
  const allVariantUrls: string[] = [];
  const usedUrls = new Set<string>((data.product_images || []) as string[]);
  for (const item of data.variant_images || []) {
    for (const urls of Object.values(item)) {
      const urlList = Array.isArray(urls) ? urls : [urls as string];
      const firstUrl = urlList[0];
      if (firstUrl && !usedUrls.has(firstUrl)) {
        allVariantUrls.push(firstUrl);
        usedUrls.add(firstUrl);
      }
    }
  }
  const maxImages = workerConfig().imageUploadMaxImages;
  const mergedProductImages = [...(data.product_images || []), ...allVariantUrls].slice(0, maxImages);
  if (mergedProductImages.length > (data.product_images || []).length) {
    console.log(
      `🖼️ Product images: ${(data.product_images || []).length} gốc + ${allVariantUrls.length} từ variants → ${mergedProductImages.length} tổng`
    );
  }

  return { mergedProductImages };
};
