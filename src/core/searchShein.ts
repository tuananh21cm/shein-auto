/**
 * searchShein — nhập keyword → mở trang search SHEIN /pdsearch/<kw>/ trong 1 BrowserContext
 * anti-detect (fingerprint/proxy có sẵn) → intercept BFF qua crawlStore → gom candidate
 * (goodsId/name/price/reviews/rating/url). KHÔNG tự tạo token: để trang tự gọi API, mình chỉ
 * NGHE response (giống bản cũ harvestViaChrome — token SDK armorToken/SmDeviceId không tái tạo được).
 */
import type { BrowserContext, Page } from "playwright-core";
import { crawlStore, startStoreCapture, type StoreProduct } from "../services/kiki/storeCrawler";
import { dismissCaptcha, isCaptchaPresent, acceptCookies } from "../services/kiki/captcha";

export interface SearchOptions {
  maxPerKeyword?: number; // sp tối đa gom mỗi keyword MỖI TRANG (default 60)
  pages?: number;         // số trang search/keyword (?page=N). Default 1.
  onLog?: (m: string) => void;
}

/**
 * Vào TRANG CHỦ us.shein.com trước (set cookie/session) rồi mới sang trang search →
 * SHEIN ít nghi bot hơn hẳn so với goto thẳng /pdsearch. Gọi TRƯỚC MỖI keyword.
 */
export async function warmUpHome(page: Page, log: (m: string) => void): Promise<void> {
  try {
    await page.goto("https://us.shein.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500 + Math.floor(Math.random() * 2000));
    if (await acceptCookies(page)) { log(`   🍪 accept cookie`); await page.waitForTimeout(600); } // accept banner → ít captcha
    if (await isCaptchaPresent(page).catch(() => false)) { await dismissCaptcha(page, log); await page.waitForTimeout(1500); }
  } catch { /* ignore */ }
}

/**
 * GÕ keyword vào ô search trên trang chủ rồi Enter (điều hướng IN-SESSION) → SHEIN không nghi
 * bot (khác hẳn goto thẳng /pdsearch bị captcha). Trả true nếu đã sang được trang kết quả.
 */
export async function searchViaBox(page: Page, keyword: string, log: (m: string) => void): Promise<boolean> {
  // DOM SHEIN us.shein.com (verify 2026-09-12): input thật = input[name="header-search"].search-input,
  // TỒN TẠI nhưng 0-width/ẩn sau overlay section.search-box → isVisible()=false. Container hiện = .bsc-search-box.
  const READ = `(function(){var e=document.querySelector('input[name="header-search"],input.search-input');return e?String(e.value||''):null;})()`;

  // 1) Click vùng search hiển thị để SHEIN mở/focus input thật (như người click vào ô).
  for (const s of [".bsc-search-box", "section.search-box", ".search-box", ".search-button"]) {
    const el = page.locator(s).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      try { await el.click({ timeout: 3000 }); break; } catch { /* thử selector kế */ }
    }
  }
  await page.waitForTimeout(600);

  // 2) Focus input thật (kể cả 0-width) qua JS — Playwright .fill()/.type() bỏ qua vì "not visible".
  const has = await page.evaluate(`(function(){var e=document.querySelector('input[name="header-search"],input.search-input'); if(e){e.focus(); return true;} return false;})()`).catch(() => false);
  if (!has) { log(`   (không thấy input header-search)`); return false; }
  await page.waitForTimeout(300);

  // 3) GÕ keyword như người (element đang focus).
  await page.keyboard.type(keyword, { delay: 70 + Math.floor(Math.random() * 90) }).catch(() => {});
  await page.waitForTimeout(400);

  // 4) Verify value vào chưa; chưa thì set trực tiếp qua native setter + dispatch input (React-safe).
  let val = (await page.evaluate(READ).catch(() => "")) as string;
  if (!val || !val.trim()) {
    log(`   (keyboard chưa vào → set value trực tiếp)`);
    await page.evaluate(`(function(kw){var e=document.querySelector('input[name="header-search"],input.search-input'); if(!e)return; var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); (d&&d.set?d.set:function(v){this.value=v;}).call(e,kw); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.focus();})(${JSON.stringify(keyword)})`).catch(() => {});
    await page.waitForTimeout(300);
    val = (await page.evaluate(READ).catch(() => "")) as string;
  }
  if (!val || !val.trim()) { log(`   (không nhập được keyword vào ô)`); return false; }
  log(`   ⌨️ đã nhập "${val}" → chờ 1 xíu rồi Enter`);

  // 5) CHỜ 1 xíu RỒI Enter (user nhấn mạnh: input → chờ → enter).
  await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
  await page.keyboard.press("Enter");
  // CHỜ ĐỦ cho Enter điều hướng (đo 24/09: chờ 1.8s là quá sớm → tưởng Enter hỏng → bấm tiếp
  // nút search ở bước 6 = điều hướng LẦN 2 → SHEIN trả captcha 909).
  await page.waitForURL(/pdsearch|\/search|pdrp/i, { timeout: 7000 }).catch(() => { /* chưa đi → bước 6 */ });
  await page.waitForTimeout(1500);

  // 6) Enter không điều hướng → thử click nút search.
  if (!/pdsearch|\/search|pdrp/i.test(page.url())) {
    const btn = page.locator(".search-button").first();
    if ((await btn.count().catch(() => 0)) && (await btn.isVisible().catch(() => false))) { try { await btn.click({ timeout: 2000 }); } catch { /* ignore */ } }
    await page.waitForTimeout(2500);
  }
  const u = page.url();
  // Ở đúng trang KẾT QUẢ pdsearch, KHÔNG phải risk/challenge (param redirection cũng chứa "pdsearch" → phải loại).
  const ok = /\/pdsearch\//i.test(u) && !/\/risk\//i.test(u);
  log(`   ${ok ? "✓ search qua ô (in-session)" : (/\/risk\//i.test(u) ? "⛔ dính captcha sau Enter" : "⚠️ chưa sang kết quả")} · ${u.slice(0, 55)}`);
  return ok;
}

/**
 * CORE: goto lần lượt các URL (trang search / trang shop) trong context đã mở → crawlStore
 * intercept BFF → trả candidate DISTINCT (dedup goodsId). Warm-up homepage 1 lần trước.
 * `label(url)` chỉ để log đẹp (vd tên keyword / "shop").
 */
export async function collectFromUrls(
  ctx: BrowserContext,
  urls: string[],
  opts: SearchOptions & { label?: (u: string) => string } = {}
): Promise<StoreProduct[]> {
  const log = opts.onLog ?? (() => {});
  const label = opts.label ?? ((u: string) => u.slice(0, 50));
  const all = new Map<string, StoreProduct>();
  const page = await ctx.newPage();
  try {
    const pages = Math.max(1, opts.pages ?? 1);
    for (const url of urls) {
      if (!url) continue;
      const isSearch = /\/pdsearch\//i.test(url);
      const keyword = isSearch ? decodeURIComponent((url.match(/pdsearch\/([^/?]+)/) || [])[1] || "") : "";
      // Search: CHỈ 1 trang qua ô search (goto ?page cũng 403) → depth do crawlStore cuộn + nhiều keyword.
      // Shop: goto thẳng nên phân trang ?page dùng được.
      const effPages = isSearch ? 1 : pages;
      for (let pg = 1; pg <= effPages; pg++) {
        log(`🔎 ${label(url)}${pages > 1 ? ` · trang ${pg}` : ""}`);
        // Gắn bộ bắt JSON TRƯỚC khi điều hướng: lô sp đầu về ngay lúc load trang kết quả,
        // gắn sau (trong crawlStore) là mất giá/review/rating của cả lô đó.
        const capture = startStoreCapture(page);
        try {
          if (pg === 1) {
            log(`   ↺ homepage → gõ "${keyword || label(url)}"`);
            if (isSearch) {
              // BẮT BUỘC qua ô search (goto thẳng /pdsearch = 403). VÒNG 1 GẦN NHƯ LUÔN TRƯỢT
              // (đo 24/09: 8/8 lần đều phải sang vòng 2) → về trang chủ tìm lại, tối đa 3 vòng.
              let navigated = false;
              for (let round = 1; round <= 3 && !navigated && keyword; round++) {
                await warmUpHome(page, log);
                navigated = await searchViaBox(page, keyword, log);
                if (!navigated) log(`   ↻ vòng ${round} chưa vào được kết quả → tìm lại`);
              }
              if (!navigated) { log(`   ⏭ bỏ keyword (3 vòng search đều bị chặn)`); break; }
            } else {
              await warmUpHome(page, log);
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); // shop: goto thẳng
            }
          } else {
            // Pacing giữa các trang; trang 2+ mới goto ?page (đã trong session ấm).
            await page.waitForTimeout(4000 + Math.floor(Math.random() * 4000));
            await page.goto(url + (url.includes("?") ? "&" : "?") + "page=" + pg, { waitUntil: "domcontentloaded", timeout: 60_000 });
          }
          await page.waitForTimeout(2000);
          if (await acceptCookies(page, 2500)) log(`   🍪 accept cookie`); // banner hiện ở TRANG KẾT QUẢ search
          const before = all.size;
          const prods = await crawlStore(page, { maxProducts: opts.maxPerKeyword ?? 60, capture, onLog: (m) => log("   " + m) });
          const withRev = prods.filter((p) => p.reviewCount > 0).length;
          if (prods.length && !withRev) log(`   ⚠️ ${prods.length} sp nhưng KHÔNG có review → lọc review sẽ loại sạch (JSON SHEIN không bắt được)`);
          let fresh = 0;
          for (const p of prods) if (p.goodsId && !all.has(p.goodsId)) { all.set(p.goodsId, p); fresh++; }
          log(`   → ${prods.length} sp (${fresh} mới) · tổng ${all.size}`);
          // Proxy này đã bị SHEIN throttle (risk/limit) → BỎ luôn worker, cycle sau pool đổi proxy khác.
          if (/risk\/(action\/limit|challenge)/i.test(page.url())) {
            log(`   ⛔ proxy bị chặn (risk/limit) → dừng worker (cycle sau đổi proxy)`);
            return [...all.values()];
          }
          // Trang > 1 mà KHÔNG ra sp mới → hết trang thật sự (hoặc ?page không đổi) → dừng lặp keyword này.
          if (pg > 1 && all.size === before) { log(`   (trang ${pg} không ra sp mới → dừng phân trang)`); break; }
        } catch (e: any) {
          log(`   ⚠️ lỗi trang ${pg}: ${String(e?.message ?? e).slice(0, 60)}`);
          break;
        } finally {
          capture.stop();
        }
      }
    }
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
  return [...all.values()];
}

/** Search lần lượt keyword (→ /pdsearch/<kw>/) trong context đã mở. */
export async function searchKeywordsInContext(
  ctx: BrowserContext,
  keywords: string[],
  opts: SearchOptions = {}
): Promise<StoreProduct[]> {
  const urls = keywords.map((k) => k.trim()).filter(Boolean).map((k) => `https://us.shein.com/pdsearch/${encodeURIComponent(k)}/`);
  return collectFromUrls(ctx, urls, { ...opts, label: (u) => `search "${decodeURIComponent((u.match(/pdsearch\/([^/]+)/) || [])[1] || "")}"` });
}

/**
 * Lọc "listing ngon": đủ review (proxy bán chạy) + rating cao + trong khoảng giá, cắt top N.
 * Đo 24/09: trang kết quả SHEIN kèm khối "gợi ý cho bạn" (tăm bông $1, keo dán, tất… review 1000+)
 * → xếp theo review là đám đó chiếm sạch top. Nên: (1) có sp từ JSON tìm kiếm thì bỏ sp từ JSON
 * khác; (2) khoảng giá theo ngách loại hàng lặt vặt; (3) review trần "1001+" nên coi ≥1000 là
 * ngang nhau, xếp tiếp theo rating.
 */
export function filterGoodListings(
  items: StoreProduct[],
  f: { minReviews: number; minRating: number; limit: number; minPrice?: number; maxPrice?: number }
): StoreProduct[] {
  const hasSearch = items.some((p) => p.fromSearch === true);
  const inBand = (p: StoreProduct) =>
    p.price == null || ((f.minPrice == null || p.price >= f.minPrice) && (f.maxPrice == null || p.price <= f.maxPrice));
  const rev = (p: StoreProduct) => Math.min(p.reviewCount, 1000);
  return items
    .filter((p) => !(hasSearch && p.fromSearch === false))
    .filter((p) => p.reviewCount >= f.minReviews && (p.rating ?? 0) >= f.minRating && !!p.url && inBand(p))
    .sort((a, b) => rev(b) - rev(a) || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, f.limit);
}
