import { sizeMap, workerConfig } from "../../config/appConfig";
import { fixInflatedVariantPrices } from "./fixVariantPrices";

interface VariantImageParam {
  [color: string]: string | string[];
}

const normalizeSize = (s: string): string => sizeMap()[s.toLowerCase().trim()] ?? s;

/**
 * SHEIN trả size 2 dạng cho cùng 1 size: dạng CHỮ ("S") đọc TRƯỚC khi chọn màu, và
 * dạng SỐ ("4 (S)") đọc SAU khi chọn màu → bị trùng (chọn thừa size trên 4Seller).
 * Gộp về 1: cùng "letter" trong ngoặc → ưu tiên giữ dạng CÓ SỐ ("4 (S)"), bỏ dạng chữ trơn.
 * (available_matrix dùng dạng số → giữ số để khớp, tránh removeUnavailableVariants xoá nhầm.)
 */
const dedupeSizeForms = (sizes: string[]): string[] => {
  const byKey = new Map<string, string>();
  const order: string[] = [];
  const hasNum = (s: string) => /\d/.test(s) || /\(/.test(s); // "4 (S)" / "8/10 (L)"
  for (const s of sizes) {
    if (!s) continue;
    const m = s.match(/\(([^)]+)\)\s*$/);          // "(S)" → S
    const key = (m ? m[1] : s).toLowerCase().trim();
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, s); order.push(key); }
    else if (hasNum(s) && !hasNum(cur)) byKey.set(key, s); // ưu tiên dạng có số
  }
  return order.map((k) => byKey.get(k)!);
};

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
  // POD: mọi màu CỐ Ý dùng chung 1 ảnh design → KHÔNG dedup (sẽ xoá hết trừ 1 màu).
  const isPod = data._pod === true;

  // 0. FIX GIÁ THỔI — SHEIN thổi giá x3-x4 một số variant khi nghi crawler → chia về
  //    gần giá gốc (variant giá thường giữ nguyên). Chạy TRƯỚC dedup/filter.
  fixInflatedVariantPrices(data.variant_price, { onLog: (m) => console.log(m) });

  // 1. SIZE NORMALIZATION + DEDUP DẠNG TRÙNG
  if (data.listing_variations?.sizes) {
    const before = [...data.listing_variations.sizes];
    data.listing_variations.sizes = dedupeSizeForms(data.listing_variations.sizes.map(normalizeSize));
    data.sizes_available = dedupeSizeForms((data.sizes_available || []).map(normalizeSize));
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

  // 2. VARIANT IMAGE DEDUP (bỏ qua cho POD — mọi màu chung 1 ảnh là cố ý)
  if (!isPod && data.variant_images && data.variant_images.length > 0) {
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

  // 2b. FILTER COLORS WITHOUT IMAGES — kể cả màu có entry nhưng MẢNG RỖNG (vd màu
  //     load ảnh chậm bị cào rỗng) → tránh variant trống ảnh trên 4Seller.
  if (!isPod && data.variant_images && data.variant_images.length > 0 && data.listing_variations?.colors) {
    const hasImgs = (item: VariantImageParam): boolean => {
      const v = Object.values(item)[0];
      return Array.isArray(v) ? v.length > 0 : !!v;
    };
    data.variant_images = data.variant_images.filter(hasImgs); // bỏ entry ảnh rỗng
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

  // 3. MERGE PRODUCT IMAGES — LẤP ĐỦ tới target (mặc định imageUploadMaxImages = 9).
  //    Khi ảnh main cào về ít (vd 4), bù thêm ảnh từ variant cho đủ 9.
  //    Ưu tiên hero shot (ảnh ĐẦU mỗi màu) để khoe đa màu, rồi mới tới ảnh phụ của variant.
  const target = workerConfig().imageUploadMaxImages;
  const baseImages = (data.product_images || []) as string[];
  const mergedProductImages: string[] = [...baseImages];
  const usedUrls = new Set<string>(baseImages);

  const heroUrls: string[] = []; // ảnh đầu mỗi màu (đa dạng màu)
  const extraUrls: string[] = []; // ảnh phụ còn lại của từng màu
  for (const item of data.variant_images || []) {
    for (const urls of Object.values(item)) {
      const urlList = Array.isArray(urls) ? urls : [urls as string];
      urlList.forEach((u, idx) => {
        if (!u) return;
        (idx === 0 ? heroUrls : extraUrls).push(u);
      });
    }
  }
  for (const u of [...heroUrls, ...extraUrls]) {
    if (mergedProductImages.length >= target) break;
    if (!usedUrls.has(u)) {
      mergedProductImages.push(u);
      usedUrls.add(u);
    }
  }
  if (mergedProductImages.length > baseImages.length) {
    console.log(
      `🖼️ Ảnh main: ${baseImages.length} ảnh gốc → bù từ variant lên ${mergedProductImages.length}/${target} ảnh`
    );
  } else if (mergedProductImages.length < target) {
    console.log(`🖼️ Ảnh main: ${mergedProductImages.length}/${target} (không đủ ảnh variant để bù thêm)`);
  }

  return { mergedProductImages };
};
