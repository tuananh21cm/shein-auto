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
  /** Delay (ms) giữa mỗi lần click variant — click chậm như người để GIẢM kích captcha. Mặc định 1800. */
  variantDelayMs?: number;
  /**
   * V2 (ID-first): KHÔNG click swatch — chỉ đọc MÀU ĐANG HIỂN THỊ của trang.
   * Dùng khi orchestrator đã goto thẳng URL của từng màu (`-p-<colorGoodsId>.html`) →
   * mỗi màu là fresh load nên DOM luôn đúng → hết bug "variant kẹt" (URL nhảy, ảnh không nhảy).
   */
  noClick?: boolean;
  /**
   * V2: BỎ QUA size_chart / measure_guide / fit_reviews (product-level, giống nhau mọi màu).
   * Chỉ lấy ở màu ĐẦU → màu 2..N nhanh hơn ~10s (khỏi mở drawer + poll).
   */
  skipSizeChart?: boolean;
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
  /** Fit reviews ("How Buyer's Reviewed the Fit"): % fit + bảng buyer height/weight → size. */
  fit_reviews?: {
    trueToSizePct: number | null;
    smallPct: number | null;
    largePct: number | null;
    buyers: Record<string, string>[];
  };
  _meta?: {
    oosColors: string[];
    colorCount: number;
    variantStuck?: boolean;
    stuckColors?: string[];
    /** Số swatch màu PHÁT HIỆN sau khi bấm "Show More" (= số variant trang có lúc đầu). */
    expectedColors?: number;
    /** Số swatch ĐÃ xử lý xong (scrape ok HOẶC xác định OOS). < expected = loop bị bỏ giữa chừng (captcha/timing). */
    processedColors?: number;
  };
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
  // GIỮ NGUYÊN label US đầy đủ ("2 (XS)", "8/10 (L)") — KHÔNG cắt còn chữ.
  const normalizeShein = (raw: string): string => (raw ? raw.trim().replace(/\s+/g, " ") : raw);
  // Nút companion (Curve/Maternity/Plus Size...) = LINK sang sản phẩm khác, không phải size.
  const COMPANION_LABEL = /^\s*(curve|maternity|plus\s*size|plus|petite|tall|big\s*(?:&|and)?\s*tall|kids|men)\s*$/i;
  const isCompanionButton = (btn: any): boolean => {
    if (!btn) return false;
    const txt = (btn as HTMLElement).textContent || "";
    if (/[›>→]/.test(txt)) return true;
    if (COMPANION_LABEL.test(txt.replace(/[›>→]/g, "").trim())) return true;
    if (btn.querySelector && btn.querySelector('[class*="arrow"],[class*="chevron"],[class*="jump"]')) return true;
    return false;
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
  // SHEIN đánh dấu size HẾT HÀNG ở thẻ BỌC NGOÀI (.product-intro__size-radio),
  // KHÔNG ở <p> bên trong mà selector nhắm tới: class "...size-radio_soldout"
  // (regex cũ "sold-out" bỏ sót) + aria-disabled="true" trên thẻ bọc. Leo 3 cấp
  // cha gom class + aria-disabled để bắt đúng → tránh list SKU không có hàng.
  const isSizeSoldOut = (btn: Element): boolean => {
    let node: any = btn;
    let classBlob = "";
    let disabled = false;
    for (let up = 0; up < 3 && node; up++) {
      classBlob += " " + String(node.className || "");
      if (node.getAttribute && node.getAttribute("aria-disabled") === "true") disabled = true;
      if (node.hasAttribute && node.hasAttribute("disabled")) disabled = true;
      node = node.parentElement;
    }
    return (
      disabled ||
      /disabled|sold[\s_-]?out|out[\s_-]?of[\s_-]?stock|not[\s_-]?available|unavailable|gray|grey/i.test(classBlob)
    );
  };
  const getAvailableSizesForCurrentColor = () => {
    const buttons = Array.from(document.querySelectorAll(SELECTORS.sizeButtons));
    const available: string[] = [];
    const sold: string[] = [];
    for (const btn of buttons) {
      if (isCompanionButton(btn)) continue; // bỏ Curve/Maternity/Plus Size...
      const rawText = (btn as HTMLElement).textContent?.trim();
      if (!rawText) continue;
      const text = normalizeShein(rawText);
      if (isSizeSoldOut(btn)) sold.push(text);
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

  // 4. SIZE union — KHÔNG seed bằng size đọc TRƯỚC click màu (SHEIN trả dạng CHỮ "S";
  //    sau khi chọn màu mới ra dạng SỐ "4 (S)" → gộp cả 2 gây TRÙNG size). Chỉ gom size
  //    trong loop màu. initialSizes chỉ fallback cho sp 1 màu.
  const initialSizes = getAvailableSizesForCurrentColor().available;
  const allSizesSet = new Set<string>();

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
  //   Captcha GIỮA lúc click variant → KHÔNG dừng/noti, cứ click tiếp (theo yêu cầu — đỡ phải giải tay
  //   nhiều). Chỉ captcha lúc ĐẦU (entry, trước khi product load) mới noti Telegram + chờ giải, do
  //   orchestrator (scrapeViaKiki) lo. Bù lại: click CHẬM hơn (variantDelay) để ít kích captcha.
  const variantDelay = opts.variantDelayMs ?? 1200;

  // — Mở "Show More Colors" để render HẾT màu TRƯỚC khi click variant (lặp tới khi hết nút).
  for (let r = 0; r < 6; r++) {
    const more = Array.from(document.querySelectorAll("div,span,a,button,p")).find((el) => {
      const t = ((el as HTMLElement).innerText || "").trim();
      return /^show\s*more\s*colou?rs?/i.test(t) && t.length < 30 && (el as HTMLElement).offsetParent !== null;
    });
    if (!more) break;
    await forceClick(more);
    await wait(700);
  }

  const swatches = Array.from(document.querySelectorAll(SELECTORS.colorSwatches));
  const colorCounter: Record<string, number> = {};
  const oosColors: string[] = [];
  const stuckColors: string[] = []; // màu mà click ĐỔI URL nhưng ảnh KHÔNG đổi (lỗi SPA)
  let prevImgSig = ""; // chữ ký ảnh của màu TRƯỚC (để so sánh phát hiện "kẹt")
  const sigOf = (arr: string[]): string => arr.slice(0, 3).join("|");
  const limit = opts.maxColors && opts.maxColors > 0 ? Math.min(opts.maxColors, swatches.length) : swatches.length;

  // V2 noClick: bỏ hẳn vòng click swatch → rơi xuống nhánh "đọc màu hiện tại" bên dưới.
  if (swatches.length > 0 && !opts.noClick) {
    for (let i = 0; i < limit; i++) {
      // PACING: click chậm như người (delay + jitter ngẫu nhiên) → giảm kích captcha. KHÔNG chờ giải captcha.
      await wait(variantDelay + Math.floor(Math.random() * 1400));
      // Re-query swatch theo index (DOM có thể đổi → tránh element cũ "chết").
      const sw = (document.querySelectorAll(SELECTORS.colorSwatches)[i] as any) || swatches[i];
      if (!sw) continue;
      const prevName = (document.querySelector(SELECTORS.colorNameLabel) as HTMLElement)?.innerText.trim() ?? "";
      await forceClick(sw);
      let rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, 2500);
      // Name chưa đổi (render chậm / captcha che) → thử click lại 1 lần, KHÔNG chờ giải captcha.
      if (!rawColorName) {
        await forceClick((document.querySelectorAll(SELECTORS.colorSwatches)[i] as any) || sw);
        rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, 2000);
      }
      if (!rawColorName) {
        rawColorName =
          (sw.querySelector("img") as HTMLImageElement)?.getAttribute("alt")?.trim() || "Color" + (i + 1);
      }
      let finalColorName = rawColorName;
      if (!colorCounter[rawColorName]) colorCounter[rawColorName] = 1;
      else {
        colorCounter[rawColorName]++;
        finalColorName = `${rawColorName} ${colorCounter[rawColorName]}`;
      }

      const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();
      availSizes.forEach((s) => allSizesSet.add(s));
      // KHÔNG add soldSizes vào union → size hết hàng không lọt vào listing.
      void soldSizes;

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
      // Đổi màu: NAME đã đổi nhưng ẢNH gallery có thể load chậm/lazy → poll tới khi
      // có ảnh, tránh push MẢNG RỖNG (variant không có ảnh trên 4Seller như màu "Pink").
      const readVariantImages = (): string[] =>
        Array.from(
          new Set(
            Array.from(document.querySelectorAll(SELECTORS.allProductImages)).map((img) =>
              getOriginalImageUrl((img as HTMLImageElement).src || img.getAttribute("data-src") || (img as any).dataset?.src)
            )
          )
        ).filter(Boolean) as string[];
      await wait(300); // cho gallery bắt đầu swap
      let variantImages = readVariantImages();
      // 🐞 FIX GỐC: gallery swap CHẬM. Code cũ chỉ chờ "có ảnh" → đọc trúng ảnh màu TRƯỚC (stale) → bug
      //    "đổi URL nhưng ảnh không đổi". Với màu thứ 2+, POLL tới khi chữ ký ảnh KHÁC màu trước (đã swap),
      //    tối đa ~5.4s. (Màu đầu: chỉ cần chờ có ảnh.)
      for (let attempt = 0; attempt < 12; attempt++) {
        const empty = variantImages.length === 0;
        const stale = i > 0 && !!prevImgSig && variantImages.length > 0 && sigOf(variantImages) === prevImgSig;
        if (!empty && !stale) break;
        await wait(450);
        variantImages = readVariantImages();
      }

      // Vẫn KẸT (ảnh y hệt màu trước sau khi đã chờ) → ép click lại tối đa 3 lần.
      if (i > 0 && variantImages.length && sigOf(variantImages) === prevImgSig) {
        let recovered = false;
        for (let rc = 0; rc < 3 && !recovered; rc++) {
          const swR = (document.querySelectorAll(SELECTORS.colorSwatches)[i] as any) || sw;
          await forceClick(swR);
          await wait(900);
          const vi = readVariantImages();
          if (vi.length && sigOf(vi) !== prevImgSig) {
            variantImages = vi;
            recovered = true;
          }
        }
        if (!recovered) stuckColors.push(finalColorName); // vẫn kẹt → orchestrator restart session cào lại
      }
      if (variantImages.length) prevImgSig = sigOf(variantImages);

      data.listing_variations.colors.push(finalColorName);
      data.variant_ids.push({ [finalColorName]: currentId });
      // Cap 9 ảnh/màu (giới hạn 4Seller/TikTok) — SHEIN có màu 10-11 ảnh → tránh "Exceeding image count".
      data.variant_images.push({ [finalColorName]: variantImages.slice(0, 9) });
      data.variant_price.push({ [finalColorName]: priceText });
      data.available_matrix[finalColorName] = availSizes;
    }
  } else {
    // Đọc MÀU ĐANG HIỂN THỊ (dùng cho noClick/V2, và cho sp 1 màu không có swatch).
    // Tên màu: ưu tiên label màu đang chọn (đúng màu của trang), fallback attribute Color.
    const labelColor = (document.querySelector(SELECTORS.colorNameLabel) as HTMLElement)?.innerText.trim() || "";
    const colorKey = Object.keys(attributes).find((k) => ["Color", "Farbe", "Couleur"].includes(k));
    const fallbackColor = labelColor || (colorKey && attributes[colorKey]) || "Default";
    const { available: availSizes } = getAvailableSizesForCurrentColor();
    availSizes.forEach((s) => allSizesSet.add(s));
    if (availSizes.length === 0) oosColors.push(fallbackColor);
    data.listing_variations.colors.push(fallbackColor);
    data.variant_ids.push({ [fallbackColor]: getProductIdFromUrl() ?? "Unknown" });
    // Cap 9 ảnh (giới hạn 4Seller/TikTok) — giống nhánh click.
    data.variant_images.push({ [fallbackColor]: [...productImages].slice(0, 9) });
    data.variant_price.push({
      [fallbackColor]: (document.querySelector(SELECTORS.price) as HTMLElement)?.innerText.trim() ?? "0",
    });
    data.available_matrix[fallbackColor] = availSizes.length > 0 ? availSizes : initialSizes;
  }

  // Union = size đọc SAU khi chọn màu (dạng số chuẩn). Fallback initialSizes nếu rỗng.
  const finalSizes = allSizesSet.size ? Array.from(allSizesSet) : initialSizes;
  data.listing_variations.sizes = finalSizes;
  data.sizes_available = finalSizes;
  data._meta = {
    oosColors,
    colorCount: data.listing_variations.colors.length,
    variantStuck: stuckColors.length > 0,
    stuckColors,
    // STRICT COUNT: `limit` = số swatch cần xử lý (= swatches.length sau Show-More, hoặc maxColors nếu
    // chủ động giới hạn). processed = số màu cào được + số màu OOS. Nếu processed < limit nghĩa là loop
    // bị bỏ swatch giữa chừng (captcha/timing) → orchestrator coi là CRAWL FAIL.
    // noClick (V2): mỗi lần gọi CHỈ đọc 1 màu (orchestrator goto từng màu) → expected = 1,
    // KHÔNG phải số swatch trên trang (nếu không assertColorCount sẽ báo fail oan).
    expectedColors: opts.noClick ? 1 : limit,
    processedColors: data.listing_variations.colors.length + oosColors.length,
  };

  // 6. SIZE CHART
  // ƯU TIÊN đúng nút trigger `.product-intro__size-guide` (đã verify click mở drawer). OR-selector cũ
  //   `querySelector(a, b, c)` trả element ĐẦU DOM khớp BẤT KỲ → vớ nhầm `[class*="size-guide"]`
  //   không phải nút bấm → click không mở drawer → mất size_chart.
  const sizeBtn =
    document.querySelector(".product-intro__size-guide-new") ||
    document.querySelector(".product-intro__size-guide") ||
    document.querySelector(".size-guide-tag") ||
    Array.from(document.querySelectorAll("div, span, p, a, button")).find((el) => {
      const t = ((el as HTMLElement).innerText || el.textContent || "").trim();
      return /^(size guide|size chart|größentabelle|guide des tailles)$/i.test(t);
    }) ||
    document.querySelector('[class*="size-guide"]') ||
    document.querySelector('[class*="size-chart"]');
  // skipSizeChart (V2): size_chart/measure/fit là PRODUCT-LEVEL (giống nhau mọi màu) → chỉ mở
  // drawer ở màu ĐẦU. Bỏ qua ở màu 2..N tiết kiệm ~10s/màu (drawer poll tới 8s).
  if (sizeBtn && !opts.skipSizeChart) {
    await forceClick(sizeBtn);
    // Drawer Size Guide load ASYNC → POLL chờ NỘI DUNG (bảng / measure-guide / unit-toggle), tối đa ~8s.
    //   KHÔNG click lại để "thử mở": click lần 2 TOGGLE ĐÓNG drawer → đọc rỗng. Nếu sau 8s vẫn trống
    //   thường là SHEIN ẨN size chart (nghi bot) → size_chart=null → orchestrator cho vào hàng đợi cào lại.
    const drawerReady = (): boolean =>
      !!document.querySelector(
        ".bsc-common-size-table__content_inner-table tbody tr, .bsc-size-measure-guide__desc, .bsc-size-unit-switch"
      );
    for (let w = 0; w < 27; w++) {
      if (drawerReady()) break;
      await wait(300);
    }
    await wait(400);

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
      // Ưu tiên bảng bsc của drawer (tránh querySelector OR vớ nhầm table khác trên trang
      //   như bảng fit-reviews, do querySelector chọn theo THỨ TỰ DOM không theo thứ tự selector).
      const table =
        document.querySelector(".bsc-common-size-table__content_inner-table") ||
        document.querySelector("[class*='size-table'] table") ||
        document.querySelector(".bsc-size-table") ||
        document.querySelector(".she-drawer table, .modal table");
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

    // Fit reviews ("How Buyer's Reviewed the Fit"): % fit + bảng buyer (height/weight → size).
    try {
      const fitBox = Array.from(document.querySelectorAll("div,section")).find(
        (el) => /true to size/i.test((el as HTMLElement).textContent || "") && ((el as HTMLElement).textContent || "").length < 500
      ) as HTMLElement | undefined;
      const ft = fitBox?.innerText || "";
      const pct = (re: RegExp) => {
        const m = ft.match(re);
        return m ? Number(m[1]) : null;
      };
      const fit: any = {
        trueToSizePct: pct(/true to size[:\s]*([\d.]+)\s*%/i),
        smallPct: pct(/small[:\s]*([\d.]+)\s*%/i),
        largePct: pct(/large[:\s]*([\d.]+)\s*%/i),
        buyers: [] as Record<string, string>[],
      };
      const buyerTable = Array.from(document.querySelectorAll("table")).find((tb) =>
        /buyer/i.test((tb.querySelector("thead") as HTMLElement)?.innerText || "")
      );
      if (buyerTable) {
        const bh = Array.from(buyerTable.querySelectorAll("thead th, thead td")).map((td) =>
          (td as HTMLElement).innerText.trim()
        );
        fit.buyers = Array.from(buyerTable.querySelectorAll("tbody tr"))
          .map((row) => {
            const cells = Array.from(row.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText.trim());
            const obj: Record<string, string> = {};
            bh.forEach((h, i) => {
              if (h) obj[h] = cells[i];
            });
            return obj;
          })
          .filter((b) => Object.values(b).some((v) => v && v !== "-" && v !== "-/-"));
      }
      if (fit.trueToSizePct != null || fit.buyers.length) data.fit_reviews = fit;
    } catch {
      /* ignore */
    }

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
