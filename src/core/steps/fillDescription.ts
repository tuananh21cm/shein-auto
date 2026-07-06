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

/**
 * HTML khối "How To Measure" để chèn vào mô tả listing.
 * Bố cục: tiêu đề → danh sách số đo (TEXT trước) → ảnh sơ đồ (CUỐI). Đặt ảnh base64
 * lớn ở cuối để nếu CKEditor cắt paste sau ảnh thì cũng không mất phần text quan trọng.
 */
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

/**
 * Upload 1 ảnh (file PNG local) vào CKEditor qua nút ảnh của toolbar → 4Seller host ảnh
 * (render được, khác hẳn base64/blob bị editor bỏ qua). atStart=true → ảnh ĐẦU mô tả.
 */
export const uploadImageToEditor = async (
  page: any,
  filePath: string,
  atStart = true
): Promise<void> => {
  try {
    const editor = page.locator(".ck-editor__editable_inline").first();
    await editor.scrollIntoViewIfNeeded();
    await editor.click();
    await page.keyboard.press(atStart ? "Control+Home" : "Control+End");
    await page.waitForTimeout(200);

    // DEBUG: liệt kê MỌI button trong toolbar (gồm .fullscreen-wrapper__toolbar) + tooltip
    const ctrls = await page
      .locator(".ck-toolbar button, .fullscreen-wrapper__toolbar button")
      .evaluateAll((els: any[]) =>
        els.map((e, i) => ({
          i,
          t:
            e.getAttribute("data-cke-tooltip-text") ||
            e.getAttribute("aria-label") ||
            e.getAttribute("title") ||
            "",
          c: (e.className || "").replace(/\bck-/g, "").replace(/\s+/g, " ").trim(),
        }))
      );
    console.log(`🔎 [IMG] buttons: ${JSON.stringify(ctrls)}`);

    const tryFC = async (clickFn: () => Promise<void>): Promise<boolean> => {
      const fcP = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
      await clickFn();
      const fc = await fcP;
      if (fc) {
        await fc.setFiles(filePath);
        return true;
      }
      return false;
    };

    let done = false;
    // 1. Dropdown ảnh trong toolbar (dropdown không phải Heading)
    const imgDd = page.locator(".ck-toolbar .ck-dropdown:not(.ck-heading-dropdown)").first();
    if ((await imgDd.count()) > 0) {
      done = await tryFC(async () => {
        await imgDd.locator("button").first().click();
      });
      if (!done) {
        await page.waitForTimeout(300);
        const panelTexts = await page
          .locator(".ck-dropdown__panel button, .ck-dropdown__panel .ck-button, .ck-balloon-panel button")
          .evaluateAll((els: any[]) =>
            [...new Set(els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()).filter(Boolean))]
          );
        console.log(`🔎 [IMG] panel options: ${JSON.stringify(panelTexts)}`);
        const upBtn = page
          .locator(".ck-dropdown__panel button, .ck-balloon-panel button, .ck-dropdown__panel .ck-button")
          .filter({ hasText: /upload|computer|file|máy/i })
          .first();
        if ((await upBtn.count()) > 0) done = await tryFC(async () => await upBtn.click());
      }
    }
    // 2. Fallback: button toolbar có aria-label chứa "image"
    if (!done) {
      const imgBtn = page.locator('.ck-toolbar button[aria-label*="image" i]').first();
      if ((await imgBtn.count()) > 0) done = await tryFC(async () => await imgBtn.click());
    }

    if (done) {
      await page.waitForTimeout(4000); // chờ 4Seller upload xong
      const imgs = await editor.locator("img").count();
      console.log(`🖼️ Upload ảnh Size Guide vào mô tả (atStart=${atStart}) → editor có ${imgs} ảnh`);
    } else {
      console.warn("⚠️ Không kích hoạt được file dialog upload ảnh trong editor.");
    }
  } catch (e: any) {
    console.warn("⚠️ uploadImageToEditor lỗi:", e?.message);
  }
};

/**
 * Dọn HTML mô tả trong editor (chạy SAU khi điền xong toàn bộ text + ảnh):
 *  - Xoá <figure> không còn <img> bên trong (ảnh bị editor strip → khung rỗng)
 *  - Gộp 2+ paragraph trống liên tiếp thành 1 (nguồn gốc "trống mấy dòng" giữa mô tả)
 * Thao tác qua CKEditor instance API (getData/setData) để model + view đồng bộ —
 * sửa DOM trực tiếp sẽ bị CKEditor bỏ qua khi save.
 */
export const cleanupEditorHtml = async (page: any): Promise<void> => {
  try {
    const changed = await page.evaluate(() => {
      const el = document.querySelector(".ck-editor__editable_inline") as any;
      const inst = el && el.ckeditorInstance;
      if (!inst || typeof inst.getData !== "function") return false;
      const before = inst.getData();
      let html = before;
      // figure không chứa img → bỏ cả figure
      html = html.replace(/<figure(?:(?!<img)[\s\S])*?<\/figure>/g, "");
      // 2+ paragraph trống liên tiếp (<p></p>, <p>&nbsp;</p>, <p><br></p>...) → 1
      const emptyP = "<p>(?:&nbsp;|\\s|<br[^>]*>)*</p>\\s*";
      html = html.replace(new RegExp(`(?:${emptyP}){2,}`, "g"), "<p><br></p>");
      if (html !== before) {
        inst.setData(html);
        return true;
      }
      return false;
    });
    if (changed) console.log("🧹 Đã dọn mô tả: bỏ figure rỗng / gộp dòng trống thừa.");
  } catch (e: any) {
    console.warn("⚠️ cleanupEditorHtml lỗi (bỏ qua):", e?.message);
  }
};

export const fillDescription = async (page: any, text: string): Promise<void> => {
  const editor = page.locator(".ck-editor__editable_inline").first();
  const html = `<div style="font-family: Arial;">${text}</div>`;

  try {
    console.log("--- Đang điền mô tả sản phẩm ---");
    await editor.scrollIntoViewIfNeeded();
    await editor.click();
    await page.waitForTimeout(200);

    // CÁCH 1 (bền): set thẳng qua CKEditor 5 instance API (DOM editable có .ckeditorInstance).
    //   Clipboard paste (cách cũ) hay fail headless/perm/focus → mô tả rỗng dù log "thành công".
    const method = await page.evaluate((h: string) => {
      const el = document.querySelector(".ck-editor__editable_inline") as any;
      const inst = el && el.ckeditorInstance;
      if (inst && typeof inst.setData === "function") {
        inst.setData(h);
        return "api";
      }
      if (el) {
        el.innerHTML = h;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return "innerHTML";
      }
      return "none";
    }, html);

    await page.waitForTimeout(300);
    let len = ((await editor.innerText().catch(() => "")) || "").trim().length;

    // CÁCH 2 (fallback): clipboard paste nếu setData không vào.
    if (len === 0) {
      console.warn(`⚠️ setData (${method}) không vào → thử clipboard paste…`);
      await editor.click();
      await page.evaluate(async (val: string) => {
        const type = "text/html";
        const blob = new Blob([val], { type });
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      }, html);
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.keyboard.press("Control+V");
      await page.waitForTimeout(400);
      len = ((await editor.innerText().catch(() => "")) || "").trim().length;
    }

    // Kích hoạt validate (mất "Can not be empty"): gõ 1 space ở cuối rồi xoá → fire input thật.
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");

    if (len > 0) console.log(`✅ Mô tả đã điền (${method}, ${len} ký tự).`);
    else console.error("❌ Mô tả VẪN rỗng sau cả setData + clipboard — cần soi tay.");
  } catch (error) {
    console.error("❌ Lỗi điền mô tả:", error);
  }
};

/**
 * Chọn ảnh đại diện từ variant_images để chèn vào description — CÓ CHỦ ĐÍCH
 * (bỏ random cũ dễ trúng 2 ảnh na ná / bỏ sót màu):
 * - Round 1: ảnh HERO (ảnh đầu) của TỪNG màu, theo thứ tự → khoe đủ màu.
 * - Round 2: 1 ảnh DETAIL = ảnh CUỐI của màu đầu (SHEIN thường để ảnh zoom chất liệu cuối).
 * - Round 3: nếu còn slot, bù ảnh thứ 2/3... của từng màu (vẫn deterministic).
 */
export const selectDescriptionImages = (variantImages: any[], maxImages?: number): string[] => {
  const limit = maxImages ?? workerConfig().descriptionImagesCount;
  const allVariants: { color: string; urls: string[] }[] = [];
  for (const item of variantImages) {
    for (const [color, urls] of Object.entries(item)) {
      allVariants.push({ color, urls: (urls as string[]).filter(Boolean) });
    }
  }

  const selected: string[] = [];
  const usedUrls = new Set<string>();
  const push = (u?: string) => {
    if (u && !usedUrls.has(u) && selected.length < limit) {
      selected.push(u);
      usedUrls.add(u);
    }
  };

  // 1. Hero mỗi màu
  for (const v of allVariants) push(v.urls[0]);
  // 2. Ảnh detail (cuối của màu đầu)
  if (allVariants.length > 0) push(allVariants[0].urls[allVariants[0].urls.length - 1]);
  // 3. Bù ảnh phụ theo vòng nếu còn slot
  for (let idx = 1; selected.length < limit; idx++) {
    const before = selected.length;
    for (const v of allVariants) push(v.urls[idx]);
    if (selected.length === before) break; // hết ảnh để bù
  }
  return selected;
};

export const uploadDescriptionImages = async (
  page: any,
  imageUrls: string[],
  opts?: {
    /** HTML chèn TRƯỚC cụm ảnh (vd heading "📸 Details Up Close"). */
    headingHtml?: string;
    /** HTML chèn SAU cụm ảnh (vd trust banner cuối mô tả). */
    trailingHtml?: string;
  }
): Promise<void> => {
  if ((!imageUrls || imageUrls.length === 0) && !opts?.trailingHtml) return;

  console.log(`--- Bắt đầu chèn ${imageUrls.length} ảnh vào mô tả sản phẩm ---`);
  const editor = page.locator(".ck-editor__editable_inline").first();

  // 4Seller chỉ nhận JPG/JPEG/PNG ở ảnh mô tả. Ảnh SHEIN là .webp → đổi đuôi sang .jpg
  // (CDN ltwebstatic trả image/jpeg cho cùng path .jpg → không cần tải/reupload).
  const toJpg = (u: string) => u.replace(/\.webp(\?|$)/i, ".jpg$1");
  const figures = (imageUrls || [])
    .map(
      (url, i) =>
        `<figure class="image"><img src="${toJpg(url)}" alt="Product image ${i + 1}"></figure>`
    )
    .join("");
  const imgHtml =
    (figures ? (opts?.headingHtml || "") : "") + figures + (opts?.trailingHtml || "");

  await editor.click();

  // APPEND qua CKEditor instance API (giữ mô tả text đã có + nối ảnh). Bền hơn clipboard paste.
  const method = await page.evaluate((h: string) => {
    const el = document.querySelector(".ck-editor__editable_inline") as any;
    const inst = el && el.ckeditorInstance;
    if (inst && typeof inst.setData === "function" && typeof inst.getData === "function") {
      inst.setData(inst.getData() + h);
      return "api";
    }
    if (el) {
      el.innerHTML += h;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return "innerHTML";
    }
    return "none";
  }, imgHtml);

  await page.waitForTimeout(1500);

  // trigger validate
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");

  const imgCount = await editor.locator("img").count();
  console.log(`✅ Mô tả giờ có ${imgCount} ảnh (${method}).`);
};
