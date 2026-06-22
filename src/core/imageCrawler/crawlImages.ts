/**
 * Module cào ẢNH từ trang listing/collection bất kỳ. 2 chế độ phân trang:
 *  - "pagination": đi qua ?page=1,2,3… (hoặc click nút Next) tới khi hết.
 *  - "loadmore"  : click nút "Load More" / cuộn vô tận tới khi không còn item mới.
 *
 * Lấy title + ảnh chính của mỗi sản phẩm, NÂNG width ảnh (vd 760 → 1280) rồi lưu file
 * theo tên title. Dùng Playwright (render JS) → chạy được cả grid lazy-load.
 */
import { chromium } from "playwright-core";
import axios from "axios";
import fs from "fs-extra";
import path from "path";

export interface CrawlImagesOpts {
  url: string;
  mode: "pagination" | "loadmore";
  outputDir: string;
  /** Width đích cho ảnh (thay tham số width hiện có). Mặc định 1280. */
  targetWidth?: number;
  /** Giới hạn số trang (pagination) — mặc định 20. */
  maxPages?: number;
  /** Giới hạn số lần load-more/scroll — mặc định 30. */
  maxLoadMore?: number;
  /** Giới hạn tổng số ảnh tải (0 = không giới hạn). */
  maxImages?: number;
  /** Selector nút Load More (loadmore). Rỗng = tự dò + fallback cuộn vô tận. */
  loadMoreSelector?: string;
  /** Regex (string) khớp href link sản phẩm. Mặc định Shopify + osCommerce (-p-NNNN.html). */
  linkPattern?: string;
  /** Selector card sản phẩm (để lấy ảnh + title quanh link). */
  cardSelector?: string;
  /** Selector title trong card (nếu site có element tên riêng). Rỗng = tự dò / suy từ URL. */
  titleSelector?: string;
  headless?: boolean;
  onLog?: (m: string) => void;
}

const DEFAULT_LINK_PATTERN = "/products?/|-p-\\d+\\.html|/item/";
const DEFAULT_CARD_SELECTOR =
  ".product-itm, [class*='product-card'], [class*='product-item'], [class*='product-tile'], .grid__item, .grid-product";

export interface CrawledItem {
  title: string;
  img: string;
}

/** Nâng width ảnh lên target: ?width=N → target; _NxM → _targetx; Shopify CDN → thêm width. */
export function upscaleImageUrl(raw: string, target: number): string {
  let url = raw.trim();
  if (url.startsWith("//")) url = "https:" + url;
  url = url.replace(/&amp;/g, "&");
  if (/[?&]width=\d+/i.test(url)) return url.replace(/([?&]width=)\d+/i, `$1${target}`);
  if (/_\d+x\d*\.(jpg|jpeg|png|webp)/i.test(url)) return url.replace(/_\d+x\d*(\.(?:jpg|jpeg|png|webp))/i, `_${target}x$1`);
  if (/(cdn\.shopify\.com|\/cdn\/shop\/)/i.test(url)) return url + (url.includes("?") ? "&" : "?") + `width=${target}`;
  return url;
}

/** Sanitize title → tên file an toàn. */
const safeName = (title: string): string =>
  (title || "image")
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "image";

/** Build URL với ?page=N (thay/append param page). */
const withPage = (url: string, page: number): string => {
  const u = new URL(url);
  u.searchParams.set("page", String(page));
  return u.toString();
};

/** Trích title + ảnh chính mỗi sản phẩm trên trang hiện tại (dedup theo link sản phẩm). */
async function extractItems(
  page: any,
  cfg: { linkPattern: string; cardSelector: string; titleSelector: string }
): Promise<CrawledItem[]> {
  // LƯU Ý: callback chạy trong trình duyệt — KHÔNG khai báo hàm con có tên (tsx/esbuild
  // chèn helper __name → "__name is not defined"). Inline toàn bộ logic.
  return page.evaluate((c: { linkPattern: string; cardSelector: string; titleSelector: string }) => {
    const linkRe = new RegExp(c.linkPattern, "i");
    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const byHandle: Record<string, { title: string; img: string }> = {};
    for (const a of anchors) {
      const handle = (a.getAttribute("href") || "").split("?")[0];
      if (!handle || !linkRe.test(handle) || byHandle[handle]) continue;
      const card =
        (a.closest(c.cardSelector) as HTMLElement) ||
        (a.closest("li, article") as HTMLElement) ||
        (a.parentElement as HTMLElement) || a;
      const img = card.querySelector("img") as HTMLImageElement | null;
      if (!img) continue;
      // Ảnh: ưu tiên data-srcset/srcset (width lớn nhất), rồi data-src, rồi src; bỏ placeholder data:.
      let src = "";
      const srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || "";
      if (srcset) {
        let bestW = -1;
        for (const part of srcset.split(",")) {
          const seg = part.trim().split(/\s+/);
          const wn = seg[1] ? parseInt(seg[1]) : 0;
          if (seg[0] && wn >= bestW) { bestW = wn; src = seg[0]; }
        }
      }
      if (!src) src = img.getAttribute("data-src") || "";
      if (!src) { const s = img.getAttribute("src") || ""; if (s && !s.startsWith("data:")) src = s; }
      if (!src || src.startsWith("data:")) continue;

      // Title: selector chỉ định → tự dò element tên → suy từ handle URL nếu xấu (rỗng/dài/có giá $).
      let title = "";
      if (c.titleSelector) title = (card.querySelector(c.titleSelector)?.textContent || "");
      if (!title) {
        const tEl = card.querySelector(
          ".product-title-truncate, [class*='product-name'], [class*='product-title'], .card__heading, [class*='card-title'], [class*='product-item__title'], h2, h3, h4"
        );
        title = tEl?.textContent || img.getAttribute("alt") || "";
      }
      title = title.replace(/\s+/g, " ").trim();
      if (!title || title.length > 90 || /\$\s?\d/.test(title)) {
        let seg = handle.replace(/\/+$/, "").split("/").pop() || "";
        seg = seg.replace(/\.html?$/i, "").replace(/-p-\d+$/i, "").replace(/-\d+$/, "");
        title = seg.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (m) => m.toUpperCase());
      }
      byHandle[handle] = { title: title || "image", img: src };
    }
    return Object.values(byHandle);
  }, cfg);
}

/** Tải 1 ảnh → lưu vào outputDir theo title (tránh trùng tên). Trả tên file đã lưu. */
async function downloadImage(url: string, title: string, outputDir: string): Promise<string> {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(url).origin },
  });
  const ct = String(res.headers["content-type"] || "");
  let ext = (url.split("?")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1] || "").toLowerCase();
  if (!ext) ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const base = safeName(title);
  let name = `${base}.${ext}`;
  let i = 2;
  while (await fs.pathExists(path.join(outputDir, name))) name = `${base}_${i++}.${ext}`;
  await fs.writeFile(path.join(outputDir, name), new Uint8Array(Buffer.from(res.data)));
  return name;
}

export async function crawlImages(opts: CrawlImagesOpts): Promise<{ saved: number; failed: number; dir: string }> {
  const {
    url,
    mode,
    outputDir,
    targetWidth = 1280,
    maxPages = 20,
    maxLoadMore = 30,
    maxImages = 0,
    loadMoreSelector,
    headless = true,
  } = opts;
  const log = (m: string) => opts.onLog?.(m);
  const cfg = {
    linkPattern: opts.linkPattern || DEFAULT_LINK_PATTERN,
    cardSelector: opts.cardSelector || DEFAULT_CARD_SELECTOR,
    titleSelector: opts.titleSelector || "",
  };

  await fs.ensureDir(outputDir);
  log(`🚀 Mở trình duyệt (headless=${headless})…`);
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" });
  const page = await ctx.newPage();
  log(`✅ Trình duyệt sẵn sàng.`);

  const collected = new Map<string, CrawledItem>(); // key = img url (dedup)
  const out = { saved: 0, failed: 0, dir: outputDir };

  const addItems = (items: CrawledItem[]): number => {
    let added = 0;
    for (const it of items) {
      if (!collected.has(it.img)) { collected.set(it.img, it); added++; }
    }
    return added;
  };

  // Đếm số SẢN PHẨM (link khớp linkPattern) — không phụ thuộc ảnh đã lazy-load xong chưa.
  const countProducts = (): Promise<number> =>
    page.evaluate((pat: string) => {
      const re = new RegExp(pat, "i");
      const set = new Set<string>();
      document.querySelectorAll("a[href]").forEach((a) => {
        const h = (a.getAttribute("href") || "").split("?")[0];
        if (h && re.test(h)) set.add(h);
      });
      return set.size;
    }, cfg.linkPattern);

  // Chờ grid render xong (SPA/Cloudflare chậm): poll tới khi số sp >0 và ỔN ĐỊNH 2 nhịp.
  const waitForProducts = async (maxMs = 18000): Promise<number> => {
    let last = -1, stable = 0;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(1000);
      const c = await countProducts();
      if (c > 0 && c === last) { stable++; if (stable >= 2) return c; } else stable = 0;
      last = c;
    }
    return last < 0 ? 0 : last;
  };

  try {
    if (mode === "pagination") {
      for (let p = 1; p <= maxPages; p++) {
        const target = withPage(url, p);
        log(`📄 Trang ${p}: ${target}`);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        await waitForProducts();
        const items = await extractItems(page, cfg);
        const added = addItems(items);
        log(`   +${added} sản phẩm mới (tổng ${collected.size})`);
        if (added === 0) { log(`   Hết sản phẩm → dừng phân trang.`); break; }
      }
    } else {
      // Cuộn TĂNG DẦN xuống đáy: render card lazy + kích hoạt infinite-scroll observer.
      const autoScroll = (): Promise<void> =>
        page.evaluate(async () => {
          const sentinel = document.querySelector(
            '[data-predictive-loading], [class*="infinite"], [class*="load-more"], [class*="load_more"]'
          ) as HTMLElement | null;
          const step = Math.max(500, window.innerHeight);
          let lastH = 0;
          for (let k = 0; k < 20; k++) {
            window.scrollBy(0, step);
            window.dispatchEvent(new Event("scroll"));
            if (sentinel) sentinel.scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 350));
            if (document.body.scrollHeight === lastH && k > 4) break;
            lastH = document.body.scrollHeight;
          }
        });

      // loadmore: load trang đầu, CUỘN render batch đầu, rồi mỗi vòng: cuộn + click nút (nếu có).
      log(`📄 Mở ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForProducts();
      await autoScroll();
      await page.waitForTimeout(1500);
      addItems(await extractItems(page, cfg));
      log(`   ${collected.size} sản phẩm ban đầu`);

      const btnSel = loadMoreSelector ||
        'button:has-text("Load More"), a:has-text("Load More"), button:has-text("Load more"), a:has-text("Load more"), [class*="load-more"] button, [class*="load_more"], button[class*="load"]';

      let prevCount = await countProducts();
      let stale = 0;
      const STALE_LIMIT = 3; // 3 vòng không tăng (mỗi vòng poll tới ~12s) mới coi là hết
      for (let i = 0; i < maxLoadMore && stale < STALE_LIMIT; i++) {
        // LUÔN cuộn trước (render lazy + trigger infinite), RỒI click nút Load More nếu có.
        await autoScroll();
        const btn = page.locator(btnSel).first();
        if ((await btn.count().catch(() => 0)) && (await btn.isVisible().catch(() => false))) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click().catch(() => {});
          log(`   ▼ Cuộn + Click Load More (${i + 1})`);
        } else {
          log(`   ▼ Cuộn tải thêm (${i + 1})`);
        }
        // POLL chờ lazy-load: tối đa ~12s, dừng sớm ngay khi số sản phẩm tăng.
        let grew = false;
        for (let t = 0; t < 12; t++) {
          await page.waitForTimeout(1000);
          const c = await countProducts();
          if (c > prevCount) { prevCount = c; grew = true; break; }
        }
        addItems(await extractItems(page, cfg));
        if (grew) { stale = 0; log(`   → ${prevCount} sản phẩm (tổng ảnh ${collected.size})`); }
        else { stale++; log(`   ⏳ chưa thấy thêm sau ~12s (stale ${stale}/${STALE_LIMIT})`); }
      }
      // Pass cuối: cuộn từ trên xuống để mọi ảnh lazy gắn src thật, rồi gom lần cuối.
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 800) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
      });
      await page.waitForTimeout(800);
      addItems(await extractItems(page, cfg));
    }

    // Tải ảnh
    let items = Array.from(collected.values());
    if (maxImages > 0) items = items.slice(0, maxImages);
    log(`⬇️ Tải ${items.length} ảnh (width=${targetWidth}) → ${outputDir}`);
    for (const it of items) {
      const hiUrl = upscaleImageUrl(it.img, targetWidth);
      try {
        const name = await downloadImage(hiUrl, it.title, outputDir);
        out.saved++;
        log(`   ✅ ${name}`);
      } catch (e: any) {
        out.failed++;
        log(`   ❌ "${it.title}": ${e?.message ?? e}`);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  log(`🏁 Xong: lưu ${out.saved}, lỗi ${out.failed} → ${outputDir}`);
  return out;
}
