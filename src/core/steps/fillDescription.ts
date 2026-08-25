import { workerConfig } from "../../config/appConfig";

const SKIP_KEYS = ["SKU", "Color"];

export const generateDescriptionHtml = (
  _productName: string,
  attributes: Record<string, string>,
  _sizesAvailable?: string[],
  _colors?: string[]
): string => {
  const maxAttrs = workerConfig().descriptionMaxAttributes;
  const items: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (SKIP_KEYS.includes(key) || !value) continue;
    if (items.length >= maxAttrs) break;
    items.push({ key, value });
  }
  return items.map((item) => `<p><strong>${item.key}:</strong> ${item.value}</p>`).join("");
};

/** Fallback text "How To Measure" khi không build được ảnh Size Guide (port từ main). */
export const generateMeasureGuideHtml = (measureGuide?: {
  items: { index?: string; name: string; desc: string }[];
  image?: string | null;
}): string => {
  if (!measureGuide || !measureGuide.items?.length) return "";
  const img = measureGuide.image
    ? `<figure class="image"><img src="${measureGuide.image}" alt="How to measure guide"></figure>`
    : "";
  const list = measureGuide.items
    .map((it, i) => `<p><strong>${it.index || i + 1}. ${it.name}:</strong> ${it.desc}</p>`)
    .join("");
  return `<p><strong>📏 How To Measure</strong></p>${list}${img}`;
};

export const fillDescription = async (page: any, text: string): Promise<void> => {
  const editor = page.locator(".ck-editor__editable_inline");

  try {
    console.log("--- Đang dán mô tả sản phẩm qua Clipboard ---");
    await editor.scrollIntoViewIfNeeded();
    await editor.click();
    await page.waitForTimeout(200);

    await page.evaluate(async (val: string) => {
      const type = "text/html";
      const blob = new Blob([val], { type });
      const data = [new ClipboardItem({ [type]: blob })];
      await navigator.clipboard.write(data);
    }, `<div style="font-family: Arial;">${text}</div>`);

    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Control+V");
    console.log("✅ Đã dán nội dung thành công vào CKEditor.");

    // Kích hoạt validate để mất thông báo "Can not be empty"
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
  } catch (error) {
    console.error("❌ Lỗi khi dán nội dung Clipboard:", error);
  }
};

/**
 * Chọn ảnh đại diện từ variant_images để chèn vào description.
 * - Round 1: 1 ảnh random mỗi variant (shuffle để random thứ tự)
 * - Round 2: nếu chưa đủ maxImages, random thêm từ pool ảnh chưa dùng
 */
export const selectDescriptionImages = (variantImages: any[], maxImages?: number): string[] => {
  const limit = maxImages ?? workerConfig().descriptionImagesCount;
  const allVariants: { color: string; urls: string[] }[] = [];
  for (const item of variantImages) {
    for (const [color, urls] of Object.entries(item)) {
      allVariants.push({ color, urls: urls as string[] });
    }
  }

  const selected: string[] = [];
  const usedUrls = new Set<string>();

  const shuffled = [...allVariants].sort(() => Math.random() - 0.5);
  for (const variant of shuffled) {
    if (selected.length >= limit) break;
    const idx = Math.floor(Math.random() * variant.urls.length);
    selected.push(variant.urls[idx]);
    usedUrls.add(variant.urls[idx]);
  }

  if (selected.length < limit) {
    const pool: string[] = [];
    for (const variant of allVariants) {
      for (const url of variant.urls) {
        if (!usedUrls.has(url)) pool.push(url);
      }
    }
    const shuffledPool = pool.sort(() => Math.random() - 0.5);
    for (const url of shuffledPool) {
      if (selected.length >= limit) break;
      selected.push(url);
    }
  }
  return selected;
};

export const uploadDescriptionImages = async (page: any, imageUrls: string[]): Promise<void> => {
  if (!imageUrls || imageUrls.length === 0) return;

  console.log(`--- Bắt đầu chèn ${imageUrls.length} ảnh vào mô tả sản phẩm ---`);
  const editor = page.locator(".ck-editor__editable_inline");

  const imgHtml =
    "<br><br>" +
    imageUrls
      .map(
        (url, i) =>
          `<figure class="image"><img src="${url}" alt="Product image ${i + 1}"></figure>`
      )
      .join("");

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);

  await page.evaluate(async (html: string) => {
    const type = "text/html";
    const blob = new Blob([html], { type });
    const data = [new ClipboardItem({ [type]: blob })];
    await navigator.clipboard.write(data);
  }, imgHtml);

  await page.keyboard.press("Control+V");
  await page.waitForTimeout(3000);

  const imgCount = await editor.locator("img").count();
  console.log(`✅ Đã chèn ${imgCount} ảnh vào mô tả`);
};
