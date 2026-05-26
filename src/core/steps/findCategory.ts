import { mapCategoryToTikTok } from "../../services/gemini/mapCategoryToTikTok";
import { tiktokCategories } from "../../config/appConfig";
import { geminiCache } from "../../services/gemini/geminiCache";

export const findCategory = async (category: string): Promise<string> => {
  // Persistent disk cache — listing có category trùng (rất phổ biến trên SHEIN)
  // sẽ skip hoàn toàn Gemini call ~3,500 input tokens.
  const cached = await geminiCache.getCategory(category);
  if (cached) {
    console.log(`💾 [Category Cache] Hit: "${category.slice(0, 60)}..."`);
    return cached;
  }

  const mappingResult = await mapCategoryToTikTok(category, tiktokCategories());
  if (!mappingResult || !mappingResult.tiktok_category_path) {
    throw new Error(`findCategory thất bại: Gemini trả về null cho category "${category}"`);
  }
  const mappedPath = mappingResult.tiktok_category_path.replace(/^"|"$/g, "");
  console.log(`🗺️ Category mapped: ${mappedPath}`);
  await geminiCache.setCategory(category, mappedPath);
  return mappedPath;
};
