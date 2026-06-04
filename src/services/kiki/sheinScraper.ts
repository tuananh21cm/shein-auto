/**
 * Cào 1 trang sản phẩm SHEIN bằng cách INJECT logic (port nguyên từ Tampermonkey
 * sheincrawl-v27) vào trang qua page.evaluate. Trả về đúng shape `data` mà
 * endpoint /admin/api/ingest đang nhận → đẩy thẳng vào pipeline cũ.
 *
 * Khác bản Tampermonkey: bỏ UI/overlay + API call (dedup/ingest chuyển sang Node).
 */
import type { Page } from "playwright-core";

export interface ScrapeOptions {
  /** Chia giá cho 4 (giống checkbox "Price divider /4" của TM) */
  divide4?: boolean;
  /** Giới hạn số màu cào (an toàn). 0 = không giới hạn. */
  maxColors?: number;
}

export interface ScrapeResult {
  product_name?: string;
  category?: string;
  sizes_available: string[];
  variant_ids: Record<string, string>[];
  variant_images: Record<string, string[]>[];
  variant_price: Record<string, string>[];
  listing_variations: { colors: string[]; sizes: string[] };
  available_matrix: Record<string, string[]>;
  attributes: Record<string, string>;
  product_images: string[];
  url: string;
  market: string;
  scraped_at: string;
  size_chart?: {
    unit: string;
    /** Format mới: nhiều mảnh (vd bikini: Pants / Bikini Tops) → mỗi mảnh 1 section. */
    sections?: { name?: string; headers: string[]; data: Record<string, string>[] }[];
    /** Format cũ: 1 bảng duy nhất (giữ tương thích listing cũ). */
    data?: Record<string, string>[];
  };
  /** Hướng dẫn đo size ("How to Measure"): mô tả từng số đo + ảnh sơ đồ. */
  measure_guide?: {
    items: { index?: string; name: string; desc: string }[];
    image?: string | null;
  };
  _meta?: { oosColors: string[]; colorCount: number };
  /** Số liệu đánh giá lấy từ BFF (gắn ở scrapeViaKiki): sold/review/rating */
  stats?: {
    soldText: string | null;
    soldNum: number | null;
    reviewCount: number | null;
    rating: number | null;
    fiveStarPct: number | null;
  };
}

/**
 * Hàm chạy TRONG TRANG (browser context). Không tham chiếu biến ngoài.
 * Trả về object data.
 */
/* istanbul ignore next */
async function inPageScrape(opts: ScrapeOptions): Promise<ScrapeResult> {
  const SELECTORS = {
    colorSwatches:
      '.main-sales-attr__color-container .radio-container, .radio-container[role="radio"], [class*="color-radio"]',
    colorNameLabel: '.color-block .sub-title, [class*="color-block"] .sub-title',
    price: '#productMainPriceId, .productPrice__main, [class*="product-intro__head-mainprice"]',
    productName: '.product-intro__head-name .fsp-element, h1.product-intro__head-name',
    sizeButtons:
      '.product-intro__size-choose [class*="inner"], .size-list [class*="size-item"], .product-intro__size-radio p',
    category: ".bread-crumb__inner",
    allProductImages: "li img.fsp-element, .product-intro__main-img img, .main-img-container img",
    attrTrigger: ".common-entry__container:nth-child(1) .title, .product-intro__description-title",
    attrNames: ".product-intro__attr-list-textname",
    attrValues: ".product-intro__attr-list-textval",
    sizeGuideBtn:
      '.product-intro__size-guide, [class*="size-guide"], .size-guide-tag, [class*="size-chart"], .product-intro__size-guide-new',
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const getOriginalImageUrl = (url: string | null): string | null => {
    if (!url) return null;
    return url.replace(/_thumbnail_\d+x\d+/g, "").replace(/^\/\//, "https://");
  };
  const getProductIdFromUrl = (): string | null => {
    const m = window.location.href.match(/-p-(\d+)\.html/);
    return m ? m[1] : null;
  };
  const normalizeShein = (raw: string): string => {
    if (!raw) return raw;
    const m = raw.trim().match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : raw.trim();
  };
  const detectMarket = (): string => {
    const h = window.location.hostname;
    if (h.endsWith(".co.uk")) return "UK";
    if (h.endsWith(".de")) return "DE";
    if (h.endsWith(".fr")) return "FR";
    if (h.endsWith(".it")) return "IT";
    if (h.endsWith(".es")) return "ES";
    return "US";
  };
  const forceClick = async (el: any) => {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await wait(300);
    el.click();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  };
  const waitForChange = async (selector: string, prevText: string, timeoutMs = 2500) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector) as HTMLElement | null;
      const text = el?.innerText?.trim() ?? "";
      if (text && text !== prevText) return text;
      await wait(150);
    }
    return null;
  };
  const getAvailableSizesForCurrentColor = () => {
    const buttons = Array.from(document.querySelectorAll(SELECTORS.sizeButtons));
    const available: string[] = [];
    const sold: string[] = [];
    for (const btn of buttons) {
      const rawText = (btn as HTMLElement).textContent?.trim();
      if (!rawText) continue;
      const text = normalizeShein(rawText);
      const cls = (btn as HTMLElement).className || "";
      const parentCls = (btn.parentElement as HTMLElement)?.className || "";
      const isDisabled =
        /disabled|sold-out|sold_out|out-of-stock|not-available|gray/i.test(cls + " " + parentCls) ||
        (btn as HTMLElement).hasAttribute("disabled") ||
        btn.getAttribute("aria-disabled") === "true";
      if (isDisabled) sold.push(text);
      else available.push(text);
    }
    return { available, sold };
  };

  // 2. ATTRIBUTES
  const attrBtn = document.querySelector(SELECTORS.attrTrigger);
  if (attrBtn) {
    await forceClick(attrBtn);
    await wait(800);
  }
  const attributes: Record<string, string> = {};
  document.querySelectorAll(SELECTORS.attrNames).forEach((n, i) => {
    const val = (document.querySelectorAll(SELECTORS.attrValues)[i] as HTMLElement)?.innerText.trim();
    if (val) attributes[(n as HTMLElement).innerText.replace(":", "").trim()] = val;
  });

  // 3. ẢNH SẢN PHẨM CHUNG
  const productImages = Array.from(
    new Set(
      Array.from(document.querySelectorAll(SELECTORS.allProductImages)).map((img) =>
        getOriginalImageUrl((img as HTMLImageElement).src || img.getAttribute("data-src") || (img as any).dataset?.src)
      )
    )
  ).filter(Boolean).slice(0, 8) as string[];

  // 4. SIZE union
  const initialSizes = Array.from(document.querySelectorAll(SELECTORS.sizeButtons))
    .map((el) => normalizeShein((el as HTMLElement).textContent!.trim()))
    .filter(Boolean);
  const allSizesSet = new Set<string>(initialSizes);

  const data: ScrapeResult = {
    product_name: (document.querySelector(SELECTORS.productName) as HTMLElement)?.innerText.trim(),
    category: (document.querySelector(SELECTORS.category) as HTMLElement)?.innerText.replace(/\s+/g, " ").trim(),
    sizes_available: initialSizes,
    variant_ids: [],
    variant_images: [],
    variant_price: [],
    listing_variations: { colors: [], sizes: initialSizes },
    available_matrix: {},
    attributes,
    product_images: productImages,
    url: location.href,
    market: detectMarket(),
    scraped_at: new Date().toISOString(),
    _meta: { oosColors: [], colorCount: 0 },
  };

  // 5. LOOP TỪNG MÀU
  const swatches = Array.from(document.querySelectorAll(SELECTORS.colorSwatches));
  const colorCounter: Record<string, number> = {};
  const oosColors: string[] = [];
  const limit = opts.maxColors && opts.maxColors > 0 ? Math.min(opts.maxColors, swatches.length) : swatches.length;

  if (swatches.length > 0) {
    for (let i = 0; i < limit; i++) {
      const prevName = (document.querySelector(SELECTORS.colorNameLabel) as HTMLElement)?.innerText.trim() ?? "";
      await forceClick(swatches[i]);
      let rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, 2500);
      if (!rawColorName) {
        rawColorName =
          (swatches[i].querySelector("img") as HTMLImageElement)?.getAttribute("alt")?.trim() || "Color" + (i + 1);
      }
      let finalColorName = rawColorName;
      if (!colorCounter[rawColorName]) colorCounter[rawColorName] = 1;
      else {
        colorCounter[rawColorName]++;
        finalColorName = `${rawColorName} ${colorCounter[rawColorName]}`;
      }

      const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();
      availSizes.forEach((s) => allSizesSet.add(s));
      soldSizes.forEach((s) => allSizesSet.add(s));

      if (availSizes.length === 0) {
        oosColors.push(finalColorName);
        continue;
      }

      const currentId = getProductIdFromUrl() || "Unknown";
      let priceText = (document.querySelector(SELECTORS.price) as HTMLElement)?.innerText.trim() || "0";
      if (opts.divide4) {
        const n = parseFloat(priceText.replace(/[^0-9.]/g, ""));
        if (!isNaN(n)) priceText = (n / 4).toFixed(2);
      }
      const variantImages = Array.from(
        new Set(
          Array.from(document.querySelectorAll(SELECTORS.allProductImages)).map((img) =>
            getOriginalImageUrl((img as HTMLImageElement).src || img.getAttribute("data-src") || (img as any).dataset?.src)
          )
        )
      ).filter(Boolean) as string[];

      data.listing_variations.colors.push(finalColorName);
      data.variant_ids.push({ [finalColorName]: currentId });
      data.variant_images.push({ [finalColorName]: variantImages });
      data.variant_price.push({ [finalColorName]: priceText });
      data.available_matrix[finalColorName] = availSizes;
    }
  } else {
    const colorKey = Object.keys(attributes).find((k) => ["Color", "Farbe", "Couleur"].includes(k));
    const fallbackColor = (colorKey && attributes[colorKey]) || "Default";
    const { available: availSizes } = getAvailableSizesForCurrentColor();
    data.listing_variations.colors.push(fallbackColor);
    data.variant_ids.push({ [fallbackColor]: getProductIdFromUrl() ?? "Unknown" });
    data.variant_images.push({ [fallbackColor]: [...productImages] });
    data.variant_price.push({
      [fallbackColor]: (document.querySelector(SELECTORS.price) as HTMLElement)?.innerText.trim() ?? "0",
    });
    data.available_matrix[fallbackColor] = availSizes.length > 0 ? availSizes : initialSizes;
  }

  data.listing_variations.sizes = Array.from(allSizesSet);
  data._meta = { oosColors, colorCount: data.listing_variations.colors.length };

  // 6. SIZE CHART
  const sizeBtn =
    document.querySelector(SELECTORS.sizeGuideBtn) ||
    Array.from(document.querySelectorAll("div, span, p, a, button")).find((el) =>
      /Size Guide|Größentabelle|Guide des tailles/i.test((el as HTMLElement).innerText || el.textContent || "")
    );
  if (sizeBtn) {
    await forceClick(sizeBtn);
    await wait(1500);

    // Ép đơn vị về INCH. Toggle SHEIN: ul.bsc-size-unit-switch > li, active = .unit-active.
    const ensureInch = async (): Promise<boolean> => {
      const items = Array.from(
        document.querySelectorAll(".bsc-size-unit-switch li, .bsc-size-unit-switch [class*='unit']")
      );
      const inch = items.find((el) =>
        /^in(ch|ches)?$/i.test(((el as HTMLElement).innerText || el.textContent || "").trim())
      );
      if (inch && !inch.classList.contains("unit-active")) {
        await forceClick(inch);
        await wait(500);
      }
      return !!inch;
    };
    // Đọc bảng đang hiển thị → { headers, data }
    const readSizeTable = () => {
      const table = document.querySelector(
        ".bsc-common-size-table__content_inner-table, table, [class*='size-table']"
      );
      if (!table) return null;
      const headers = Array.from(table.querySelectorAll("thead td, thead th")).map((td) =>
        (td as HTMLElement).innerText.trim()
      );
      const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) => {
        const cells = Array.from(row.querySelectorAll("td"));
        const obj: Record<string, string> = {};
        headers.forEach((h, idx) => {
          if (h) obj[h] = (cells[idx] as HTMLElement)?.innerText.trim();
        });
        return obj;
      });
      return { headers, data: rows };
    };

    if (!(await ensureInch())) console.warn("[SHEIN-SCRAPER] Không thấy toggle IN/CM — gán unit=inch mặc định.");

    // Nhiều mảnh (vd bikini: Pants / Bikini Tops). SHEIN chỉ render bảng tab đang active →
    // phải click từng tab (.bsc-multi-part-tab > *, active = .part-active).
    const tabWrap = document.querySelector(".bsc-multi-part-tab");
    const tabs = tabWrap
      ? Array.from(tabWrap.children).filter((el) => ((el as HTMLElement).innerText || el.textContent || "").trim())
      : [];
    const sections: { name?: string; headers: string[]; data: Record<string, string>[] }[] = [];
    if (tabs.length > 1) {
      for (const tab of tabs) {
        const name = ((tab as HTMLElement).innerText || tab.textContent || "").trim();
        if (!tab.classList.contains("part-active")) {
          const prevHeader =
            (document.querySelector(".bsc-common-size-table__content_inner-table thead") as HTMLElement)
              ?.innerText.trim() ?? "";
          await forceClick(tab);
          await waitForChange(".bsc-common-size-table__content_inner-table thead", prevHeader, 2500);
          await ensureInch(); // đơn vị có thể reset khi đổi tab
        }
        const t = readSizeTable();
        if (t && t.data.length) sections.push({ name, headers: t.headers, data: t.data });
      }
    } else {
      const t = readSizeTable();
      if (t && t.data.length) sections.push({ headers: t.headers, data: t.data });
    }

    if (sections.length) data.size_chart = { unit: "inch", sections };

    // Measure guide ("How to Measure"): mô tả cách đo + ảnh sơ đồ → đưa vào mô tả listing.
    const mgItems = Array.from(document.querySelectorAll(".bsc-size-measure-guide__desc"))
      .map((d) => {
        const idx = (d.querySelector(".bsc-size-measure-guide__desc__index") as HTMLElement)?.textContent?.trim() || "";
        let name = (d.querySelector("h6") as HTMLElement)?.textContent?.trim() || "";
        if (idx && name.startsWith(idx)) name = name.slice(idx.length).trim();
        const desc = (d.querySelector("p") as HTMLElement)?.textContent?.trim() || "";
        return { index: idx, name, desc };
      })
      .filter((x) => x.name);
    const mgImgEl = document.querySelector(
      ".bsc-size-measure-guide__image img, .product_guide_img img"
    ) as HTMLImageElement | null;
    const mgImage = mgImgEl ? getOriginalImageUrl(mgImgEl.getAttribute("src") || mgImgEl.src) : null;
    if (mgItems.length) data.measure_guide = { items: mgItems, image: mgImage };

    const closeBtn = document.querySelector(".modal-header__close, .she-close-external, .f-close");
    if (closeBtn) await forceClick(closeBtn);
  }

  return data;
}

/**
 * Chạy scrape trên 1 Playwright page đã mở trang SHEIN.
 */
export async function scrapeSheinProduct(page: Page, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  // Cho trang ổn định trước khi cào
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  // tsx/esbuild (keepNames) chèn helper __name vào các hàm con → khi serialize
  // gửi vào page.evaluate sẽ "__name is not defined". Shim sẵn trong trang.
  await page.evaluate(`(function(){ if (typeof window.__name === 'undefined') { window.__name = function(fn){ return fn; }; } if (typeof window.__defProp === 'undefined') { window.__defProp = Object.defineProperty; } })()`);

  const data = (await page.evaluate(inPageScrape as any, options)) as ScrapeResult;
  return data;
}
