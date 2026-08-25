import { callClaudeJSON } from "../anthropic/client";

export interface RichDescription {
  headline: string;
  bullets: { label: string; text: string }[];
  bannerTitle: string; // nhãn ngắn cho banner, vd "Versatile Knit Cover-Up"
  bannerTagline: string; // 3 keyword lợi ích, vd "Lightweight · Breathable · Beach-Ready"
  highlights: string[]; // 4 điểm nổi bật NGẮN cho banner, vd "Soft Breathable Knit"
  /** Backend search keywords cho field "Search terms" TikTok (8-12 cụm, KHÔNG trùng từ trong title). */
  searchTerms?: string[];
  /** 5 bullet cho field "Product highlights" TikTok (mỗi dòng 1 ý, benefit-first). */
  productHighlights?: string[];
}

/**
 * Sinh mô tả marketing (kiểu TikTok Shop US) từ SHEIN attributes:
 * headline + 4 bullet (Material/Feature/Style/Occasion & Match) + nhãn banner.
 * Trả structured để caller compose (đan xen banner). Null nếu thiếu data / lỗi.
 */
export async function generateRichDescription(
  productName: string,
  attributes: Record<string, string> | undefined | null
): Promise<RichDescription | null> {
  const attrs = Object.entries(attributes || {}).filter(
    ([k, v]) => v && v.trim() && !/^(sku|color)$/i.test(k.trim())
  );
  if (attrs.length < 2) return null;

  const systemInstruction = `You are a senior TikTok Shop US copywriter (2026). Turn raw SHEIN attributes
into a polished, benefit-driven, search-optimized description (US English).

TEXT FIELDS:
- "headline": ONE SHORT hook line (max 10 words) containing the main product keyword
  (product type + key descriptor, e.g. "ribbed halter crop top").
- "bullets": EXACTLY 4 items, labels EXACTLY "Material","Feature","Style","Occasion & Match".
  Each "text" = ONE punchy sentence, 10-16 words MAX, BENEFIT-FIRST: what it does for the wearer +
  the attribute that delivers it ("Moves with you all day — stretchy ribbed knit with real hold").
  Mobile shoppers scan — SHORT and scannable beats long. No filler, no flowery adjectives chains,
  ONE idea per bullet. Weave 1 natural search keyword per bullet (fit/material/style/occasion).

TRUTHFULNESS (TikTok policy — false claims are banned, listings get removed):
- EVERY concrete claim must come from the provided attributes. NEVER invent fabric contents,
  percentages, or technical functions not given (no "quick-dry"/"UPF 50"/"seamless" unless stated).
- Aspirational tone is fine ("day-to-night versatility"); fabricated specs are not.
- NO guarantees ("100% satisfaction"), NO promo claims ("Best Seller", "Hot Sale", "Free Shipping",
  discounts), NO price/brand/shipping mentions, NO "viral"/"TikTok famous". No emojis in any field.

SEARCH & DISCOVERY FIELDS (TikTok Shop listing form):
- "searchTerms": 8-12 BACKEND search keyword phrases (each 1-4 words, lowercase) that US shoppers
  would type. These supplement the title — so DO NOT repeat words already in the product name;
  give synonyms, related phrases, and variations instead (e.g. product name says "cami dress" →
  add "summer sundress", "spaghetti strap dress", "beach dress outfit", "vacation midi").
  Must all be TRUE to this product (TikTok auto-deletes irrelevant terms). No brand names, no promo
  words. Total combined length under 230 characters.
- "productHighlights": EXACTLY 5 short benefit-first bullets for the "Product highlights" field.
  Each is ONE concise line, 4-10 words, sentence case, no ending period, no emojis.
  Cover: (1) top benefit/problem solved, (2) material/feel, (3) fit/silhouette, (4) design detail,
  (5) occasion/styling. Practical and true to attributes — no promo claims, no guarantees.

BANNER FIELDS (rendered onto marketing images — keep them clean and short):
- "bannerTitle": SHORT product label, 2-4 words, Title Case, descriptive not promotional
  (e.g. "Versatile Knit Cover-Up").
- "bannerTagline": exactly 3 benefit keywords joined by " · ", each 1-2 words, Title Case
  (e.g. "Lightweight · Breathable · Beach-Ready").
- "highlights": EXACTLY 4 selling-point phrases, each 2-4 words, Title Case, each grounded in a real
  attribute — cover different angles: material feel, fit/silhouette, design detail, occasion
  (e.g. "Soft Ribbed Knit", "Flattering Slim Fit", "Halter Neckline", "Day-to-Night Ready").

OUTPUT JSON SHAPE:
{"headline": "...", "bullets": [{"label": "Material", "text": "..."}, {"label": "Feature", "text": "..."}, {"label": "Style", "text": "..."}, {"label": "Occasion & Match", "text": "..."}], "bannerTitle": "...", "bannerTagline": "A · B · C", "highlights": ["...", "...", "...", "..."], "searchTerms": ["...", "..."], "productHighlights": ["...", "...", "...", "...", "..."]}`;

  const prompt = `Product: "${productName}"
Attributes:
${attrs.map(([k, v]) => `- ${k}: ${v}`).join("\n")}
Return JSON.`;

  try {
    const g = await callClaudeJSON<RichDescription>({
      system: systemInstruction,
      user: prompt,
      maxTokens: 1600,
    });
    if (!g?.headline || !g?.bullets?.length) return null;
    return g;
  } catch (error) {
    console.error("generateRichDescription failed:", error);
    return null;
  }
}

/**
 * Compose HTML mô tả theo SECTION (heading emoji + <h3>) thay vì bullet trơn:
 *
 *   ✨ Why You'll Love It   — headline + bullet Feature + Style
 *   [banner hero/mid]
 *   🧵 Material & Care      — bullet Material
 *   [banner còn lại]
 *   👗 Style It Your Way    — bullet Occasion & Match
 *
 * - Heading dùng <h3><strong> thuần (KHÔNG inline style) — editor 4Seller strip style
 *   không đều → chỗ to chỗ nhỏ; h3 bị strip thì vẫn còn <strong> giữ bold.
 * - KHÔNG bọc <p><br></p> quanh figure: nếu ảnh chết/bị editor strip, các thẻ đệm
 *   mồ côi thành mấy dòng trống giữa mô tả. Spacing để figure margin tự lo.
 * - opts.heroFirst: true = banner "feature" (hero trái + panel phải) đưa lên NGAY sau
 *   headline làm ấn tượng đầu, collage xuống giữa. false = collage trước (nếp cũ).
 *
 * bannerUrls: [0]=collage, [1]=feature (URL imgbb đã verify, hoặc null).
 */
export function composeRichHtml(
  rich: RichDescription,
  bannerUrls: (string | null)[] = [],
  opts?: { heroFirst?: boolean }
): string {
  const b = rich.bullets || [];
  const byLabel = (re: RegExp, fallbackIdx: number) =>
    b.find((x) => re.test(x?.label || "")) ?? b[fallbackIdx];
  const material = byLabel(/material/i, 0);
  const feature = byLabel(/feature/i, 1);
  const style = byLabel(/style/i, 2);
  const occasion = byLabel(/occasion/i, 3);

  const h = (t: string) => `<h3><strong>${t}</strong></h3>`;
  const li = (x?: { label: string; text: string }) =>
    x ? `<p>• <strong>${x.label}:</strong> ${x.text}</p>` : "";
  const fig = (url?: string | null) =>
    url ? `<figure class="image"><img src="${url}" alt="${rich.bannerTitle}"></figure>` : "";

  const collage = bannerUrls[0];
  const featureBanner = bannerUrls[1];
  const first = opts?.heroFirst ? featureBanner : collage;
  const second = opts?.heroFirst ? collage : featureBanner;

  return (
    h("✨ Why You'll Love It") +
    `<p><strong>${rich.headline}</strong></p>` +
    fig(first) +
    li(feature) +
    li(style) +
    h("🧵 Material & Care") +
    li(material) +
    fig(second) +
    h("👗 Style It Your Way") +
    li(occasion)
  );
}
