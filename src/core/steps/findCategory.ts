import { mapCategoryToTikTok } from "../../services/gemini/mapCategoryToTikTok";
import { tiktokCategories } from "../../config/appConfig";
import { geminiCache } from "../../services/gemini/geminiCache";

// Master list giờ ~10k leaf (cào full từ 4Seller) → nhét hết vào prompt Gemini là
// ~214k token/lần. LỌC ứng viên theo trùng từ khoá trước, chỉ gửi shortlist.
// "home"/"apparel"/"clothing" bị loại vì MỌI category SHEIN đều bắt đầu
// "Home / Women Apparel / Women Clothing /..." → là nhiễu, kéo rác đồ gia dụng vào shortlist.
const STOP = new Set([
  "women", "womens", "woman", "men", "mens", "man", "the", "and", "for", "with",
  "s", "set", "sets", "piece", "pieces", "pcs", "pack", "new", "girls", "girl", "boys", "boy",
  "unisex", "adult", "kids", "kid", "clothing", "apparel", "other", "accessories", "home",
  "casual", "sexy", "summer", "fashion", "style", "vacation", "beach", "outfit", "print",
]);
const tokenize = (s: string): string[] =>
  (s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * Rút gọn master list → top N leaf liên quan nhất với input (theo trùng từ khoá).
 * Từ ở SEGMENT CUỐI (leaf name) tính điểm gấp đôi. Luôn kèm vài path fallback để
 * Gemini không bí khi input lạ.
 */
const shortlistCategories = (input: string, all: string[], n = 250): string[] => {
  const q = new Set(tokenize(input));
  if (q.size === 0) return all.slice(0, n);
  const scored: { path: string; score: number }[] = [];
  for (const path of all) {
    const segs = path.split(" / ");
    const leafToks = tokenize(segs[segs.length - 1]);
    const allToks = tokenize(path);
    let score = 0;
    for (const t of allToks) if (q.has(t)) score += 1;
    for (const t of leafToks) if (q.has(t)) score += 1; // leaf khớp = +2 tổng
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, n).map((x) => x.path);
  return top.length >= 5 ? top : all.slice(0, n); // quá ít khớp → fallback list đầu
};

export const findCategory = async (category: string): Promise<string> => {
  // Persistent disk cache — listing có category trùng (rất phổ biến trên SHEIN)
  // sẽ skip hoàn toàn Gemini call.
  const cached = await geminiCache.getCategory(category);
  if (cached) {
    console.log(`💾 [Category Cache] Hit: "${category.slice(0, 60)}..."`);
    return cached;
  }

  const shortlist = shortlistCategories(category, tiktokCategories());
  console.log(`🗂️ Category shortlist: ${shortlist.length}/${tiktokCategories().length} leaf gửi Gemini`);
  const mappingResult = await mapCategoryToTikTok(category, shortlist);
  if (!mappingResult || !mappingResult.tiktok_category_path) {
    throw new Error(`findCategory thất bại: Gemini trả về null cho category "${category}"`);
  }
  const mappedPath = mappingResult.tiktok_category_path.replace(/^"|"$/g, "");
  console.log(`🗺️ Category mapped: ${mappedPath}`);
  await geminiCache.setCategory(category, mappedPath);
  return mappedPath;
};
