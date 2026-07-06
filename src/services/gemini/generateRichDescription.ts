import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface RichDescription {
  headline: string;
  bullets: { label: string; text: string }[];
  bannerTitle: string; // nhãn ngắn cho banner, vd "Versatile Knit Cover-Up"
  bannerTagline: string; // 3 keyword lợi ích, vd "Lightweight · Breathable · Beach-Ready"
  highlights: string[]; // 4 điểm nổi bật NGẮN cho banner, vd "Soft Breathable Knit"
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

  const systemInstruction = `You are a senior TikTok Shop US copywriter. Turn raw SHEIN attributes
into a polished, benefit-driven description (US English).
- "headline": ONE catchy benefit line.
- "bullets": EXACTLY 4 items, labels EXACTLY "Material","Feature","Style","Occasion & Match".
  Each "text" = 1-2 vivid marketing sentences synthesizing attributes (NOT a raw dump).
- "bannerTitle": SHORT product label, 2-4 words (e.g. "Versatile Knit Cover-Up").
- "bannerTagline": exactly 3 benefit keywords joined by " · " (e.g. "Lightweight · Breathable · Beach-Ready").
- "highlights": EXACTLY 4 punchy selling-point phrases for a marketing banner, each 2-4 words
  (e.g. "Soft Breathable Knit", "Flattering Loose Fit", "Quick-Dry Fabric", "Beach-to-Street Ready").
  You MAY embellish with plausible appealing features. No emojis.
Confident, aspirational, concise. No emojis (except none). No price/brand claims.`;

  const prompt = `Product: "${productName}"
Attributes:
${attrs.map(([k, v]) => `- ${k}: ${v}`).join("\n")}
Return JSON.`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            headline: { type: SchemaType.STRING },
            bullets: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: { label: { type: SchemaType.STRING }, text: { type: SchemaType.STRING } },
                required: ["label", "text"],
              },
            },
            bannerTitle: { type: SchemaType.STRING },
            bannerTagline: { type: SchemaType.STRING },
            highlights: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          },
          required: ["headline", "bullets", "bannerTitle", "bannerTagline", "highlights"],
        },
      },
    });
    const r = await retryGemini(() => model.generateContent(prompt));
    const g = JSON.parse(r.response.text()) as RichDescription;
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
