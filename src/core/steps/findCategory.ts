import { mapCategoryToTikTok } from "../../services/gemini/mapCategoryToTikTok";
import { tiktokCategories } from "../../config/appConfig";
import { geminiCache } from "../../services/gemini/geminiCache";

/**
 * Check xem category path có thuộc nhánh Sports & Outdoor không.
 * Swimwear/Beachwear được miễn trừ (không cần chứng chỉ).
 */
const isSportsCategory = (path: string): boolean =>
  /sports?\s*&\s*outdoor/i.test(path);

const isSwimwearCategory = (path: string): boolean =>
  /swim|surf|wetsuit|beachwear/i.test(path);

/**
 * Infer category casual phù hợp từ SHEIN category text khi Gemini vẫn
 * trả về Sports & Outdoor. Đây là fallback an toàn.
 */
const inferCasualCategory = (sheinCategory: string): string => {
  const lower = sheinCategory.toLowerCase();

  if (/dress/i.test(lower)) {
    return "Womenswear > Women's Dresses > Casual Dresses";
  }
  if (/shorts?/i.test(lower)) {
    if (/\bmen\b/i.test(lower) && !/women/i.test(lower)) {
      return "Menswear > Men's Bottoms > Men's Shorts";
    }
    return "Womenswear > Women's Bottoms > Women's Shorts";
  }
  if (/pants?|trouser|legging/i.test(lower)) {
    if (/\bmen\b/i.test(lower) && !/women/i.test(lower)) {
      return "Menswear > Men's Bottoms > Men's Pants";
    }
    return "Womenswear > Women's Bottoms > Women's Pants";
  }
  if (/set|kit|suit/i.test(lower)) {
    if (/\bmen\b/i.test(lower) && !/women/i.test(lower)) {
      return "Menswear > Men's Sets";
    }
    return "Womenswear > Women's Sets";
  }
  if (/\bmen\b/i.test(lower) && !/women/i.test(lower)) {
    return "Menswear > Men's Tops";
  }
  return "Womenswear > Women's Tops";
};

export const findCategory = async (category: string): Promise<string> => {
  // Persistent disk cache — listing có category trùng (rất phổ biến trên SHEIN)
  // sẽ skip hoàn toàn Gemini call ~3,500 input tokens.
  const cached = await geminiCache.getCategory(category);
  if (cached) {
    // Post-check: cache cũ có thể chứa Sports path → invalidate nếu cần
    if (isSportsCategory(cached) && !isSwimwearCategory(cached)) {
      const fallback = inferCasualCategory(category);
      console.warn(`⚠️ [Category Cache] Hit nhưng là Sports "${cached}" → override "${fallback}", invalidate cache`);
      await geminiCache.setCategory(category, fallback);
      return fallback;
    }
    console.log(`💾 [Category Cache] Hit: "${category.slice(0, 60)}..."`);
    return cached;
  }

  const mappingResult = await mapCategoryToTikTok(category, tiktokCategories());
  if (!mappingResult || !mappingResult.tiktok_category_path) {
    throw new Error(`findCategory thất bại: Gemini trả về null cho category "${category}"`);
  }
  let mappedPath = mappingResult.tiktok_category_path.replace(/^"|"$/g, "");

  // Deterministic fallback: nếu Gemini vẫn trả về Sports category → override
  if (isSportsCategory(mappedPath) && !isSwimwearCategory(mappedPath)) {
    const fallback = inferCasualCategory(category);
    console.warn(`⚠️ Gemini chọn Sports category "${mappedPath}" → override sang "${fallback}"`);
    mappedPath = fallback;
  }

  console.log(`🗺️ Category mapped: ${mappedPath}`);
  await geminiCache.setCategory(category, mappedPath);
  return mappedPath;
};
