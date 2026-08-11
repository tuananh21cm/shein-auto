/**
 * Caption + hashtag cho post TikTok. Ưu tiên dùng hook/CTA từ script Gemini đã lưu;
 * hashtag lấy từ script nếu có, không thì suy từ title sản phẩm (video gen trước khi
 * có field hashtags vẫn dùng được, không cần regen).
 */
import { seededRng, seededShuffle } from "./rand";

/** Từ khóa trong title → hashtag ngành hàng. */
const KEYWORD_TAGS: [RegExp, string[]][] = [
  [/bikini|swim/i, ["#bikini", "#swimwear", "#beachoutfit", "#summerbody"]],
  [/dress/i, ["#dress", "#summerdress", "#dresshaul", "#ootd"]],
  [/top|blouse|shirt|tee/i, ["#top", "#outfitinspo", "#ootd"]],
  [/skirt/i, ["#skirt", "#ootd", "#outfitinspo"]],
  [/pant|jean|trouser|short/i, ["#pants", "#ootd", "#styletips"]],
  [/set|piece/i, ["#matchingset", "#outfitideas"]],
  [/y2k/i, ["#y2k", "#y2kfashion"]],
  [/boho/i, ["#boho", "#bohostyle"]],
  [/leopard|floral|polka|print/i, ["#printedoutfit"]],
];

const BASE_TAGS = ["#tiktokshop", "#tiktokmademebuyit", "#fyp", "#fashionfinds", "#dealsforyoudays"];

/**
 * 4-6 hashtag, thứ tự ưu tiên: tag do script chỉ định (LUÔN giữ) → tag ngành hàng suy từ
 * title (shuffle theo seed để 2 video cùng loại không trùng tag y hệt) → tag chung.
 */
export function buildHashtags(title: string, seed: string, fromScript?: string[]): string[] {
  const scriptTags = (fromScript ?? [])
    .map((t) => t.trim().replace(/^#*/, "#").toLowerCase())
    .filter((t) => t.length > 1);

  const topical = new Set<string>();
  for (const [re, list] of KEYWORD_TAGS) {
    if (re.test(title)) for (const t of list) topical.add(t);
  }
  const picked = seededShuffle(seededRng(`tags:${seed}`), [...topical]);
  const base = seededShuffle(seededRng(`base:${seed}`), BASE_TAGS);

  const out: string[] = [];
  for (const t of [...scriptTags, ...picked, ...base]) {
    if (out.length >= 6) break;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Caption post: hook (câu mở) + CTA + hashtags. Cap 2200 ký tự (giới hạn TikTok). */
export function buildCaption(opts: {
  title: string;
  seed: string;
  script?: { hook?: string; cta?: string; hashtags?: string[] } | null;
}): string {
  const hook = opts.script?.hook?.trim();
  const cta = opts.script?.cta?.trim();
  const head = hook || opts.title.replace(/^\w+\s/, "").slice(0, 90); // không hook → dùng title (bỏ prefix brand)
  const tags = buildHashtags(opts.title, opts.seed, opts.script?.hashtags);
  return [head, cta, tags.join(" ")].filter(Boolean).join("\n").slice(0, 2200);
}

/**
 * Tách 1 caption (dạng "hook\ncta\n#a #b #c") thành 2 phần cho flow Content Hub mới:
 * Description (ô mô tả) và Hashtags (ô tag riêng, TikTok render thành chip).
 * Dòng nào TOÀN hashtag → gom vào hashtags; còn lại là description.
 */
export function splitCaption(caption: string): { description: string; hashtags: string[] } {
  const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  const hashtags: string[] = [];
  const descLines: string[] = [];
  for (const line of lines) {
    const toks = line.split(/\s+/);
    if (toks.length && toks.every((t) => /^#\w/.test(t))) {
      hashtags.push(...toks.map((t) => t.replace(/^#+/, "")).filter(Boolean));
    } else {
      descLines.push(line);
    }
  }
  return { description: descLines.join(" ").trim(), hashtags };
}
