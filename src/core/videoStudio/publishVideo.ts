/**
 * publishVideo — auto đăng 1 SHOPPABLE VIDEO qua Seller Center Content Hub (Kiki profile).
 *
 * ⚠️ ĐỔI FLOW (2026-07): flow cũ dùng tiktok.com/tiktokstudio/upload (creator upload) —
 * TikTok đã đổi, video đăng kiểu đó KHÔNG thành shoppable, báo "published" mà không vào
 * Posts (đã kiểm chứng: 48 video ma). Flow MỚI đăng ở seller-us.tiktok.com/content-hub:
 *
 *   1. Mở Content Hub (Seller Center — login KHÁC tiktok.com, chính là phiên analytics cào).
 *   2. Click "Post on TikTok" (nút header) → menu "Video post".
 *   3. Panel "Upload a shoppable video" → setInputFiles vào input[type=file].
 *   4. Chờ upload xong (progress → 100%).
 *   5. Điền Description (ô mô tả) + Hashtags (ô tag riêng — TikTok render thành chip).
 *   6. "Add product" → modal "Choose product": search product_id → chọn radio → Confirm.
 *   7. "Post on TikTok" (nút footer) → dialog "Your video has been posted" → "Open TikTok".
 *
 * ⚠️ PILOT LIMIT: panel hiện "You have N of 3 shoppable videos left to post" — flow này
 * giới hạn (pilot). Đọc số này ra log để biết còn quota không.
 *
 * Mỗi bước fail → screenshot data/screenshots/publish-<videoId>-<step>.png + throw kèm bước.
 */
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../../services/kiki/client";
import { splitCaption } from "./buildCaption";

const CONTENT_HUB_URL = "https://seller-us.tiktok.com/content-hub?lng=en&shop_region=US";
const SHOT_DIR = path.resolve(process.cwd(), "data", "screenshots");
const UPLOAD_WAIT_MS = 300_000;   // video upload + xử lý cover (có thể lâu)
const CAPTCHA_WAIT_MS = 180_000;  // chờ user giải captcha

export interface PublishOptions {
  profileId: string;
  videoId: number;
  videoFile: string;
  caption: string;
  productId: string;
  /** true = làm hết TRỪ nút Post cuối (test an toàn, KHÔNG tốn pilot quota). */
  dryRun?: boolean;
  /** Bỏ qua bước gắn sản phẩm (test chéo shop, product không thuộc shop đang login). */
  skipProduct?: boolean;
  /** (Giữ để tương thích — flow Content Hub không lướt feed nữa.) */
  noWarmup?: boolean;
  /** Giữ browser mở thêm N ms sau khi bấm Post cuối để soi bằng mắt. */
  holdAfterPostMs?: number;
  /** Chụp screenshot MỖI bước (debug selector lần đầu). */
  debugShots?: boolean;
  onLog?: (m: string) => void;
}

export interface PublishResult {
  posted: boolean;
  dryRun: boolean;
  productLinked: boolean;
  caption: string;
  /** Số shoppable video còn được đăng (pilot), -1 nếu không đọc được. */
  pilotLeft?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: any, videoId: number, step: string): Promise<string> {
  await fs.ensureDir(SHOT_DIR);
  const file = path.join(SHOT_DIR, `publish-${videoId}-${step}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

/** Captcha ĐANG CHẶN (node visible + đủ to). */
async function hasCaptcha(page: any): Promise<boolean> {
  try {
    if (/captcha[-_]?verify|\/secsdk[-_]?verify/i.test(page.url())) return true;
    return await page.evaluate(() => {
      const sels = ['iframe[src*="captcha" i]', '[id*="captcha-verify" i]', '[class*="captcha_verify" i]',
        '[class*="captcha-verify" i]', '[class*="secsdk-captcha" i]'];
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = getComputedStyle(el as HTMLElement);
          const visible = st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity || "1") > 0.05;
          if (visible && r.width > 120 && r.height > 120) return true;
        }
      }
      return false;
    }).catch(() => false);
  } catch { return false; }
}

async function waitCaptcha(page: any, log: (m: string) => void): Promise<void> {
  if (!(await hasCaptcha(page))) return;
  log(`⚠️ CAPTCHA — giải trong cửa sổ Kiki, script đang CHỜ (tối đa ${CAPTCHA_WAIT_MS / 1000}s)…`);
  const t0 = Date.now();
  while (Date.now() - t0 < CAPTCHA_WAIT_MS) {
    await sleep(2500);
    if (!(await hasCaptcha(page))) { log(`   ✅ Captcha đã giải, tiếp tục.`); return; }
  }
  throw new Error("Captcha không được giải trong thời gian chờ");
}

/** Click element nếu XUẤT HIỆN trong waitMs; không hiện → bỏ qua (dialog optional). */
async function clickIfVisible(page: any, selector: string, waitMs: number, log: (m: string) => void, label: string): Promise<boolean> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: "visible", timeout: waitMs });
    await loc.click({ timeout: 5000 });
    log(`   ✓ ${label}`);
    await sleep(600);
    return true;
  } catch {
    return false;
  }
}

const normText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function publishVideo(opts: PublishOptions): Promise<PublishResult> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  if (!(await fs.pathExists(opts.videoFile))) throw new Error(`Không thấy file video: ${opts.videoFile}`);

  const { description, hashtags } = splitCaption(opts.caption);

  log(`🔌 Kiki profile ${opts.profileId} — force stop + start…`);
  await kiki.forceStop(opts.profileId);
  const started = await kiki.startWithRetry(opts.profileId, (m) => log("   " + m));
  // timeout 120s: profile Kiki mở nhiều tab (tiktokstudio/seller) → Playwright liệt kê
  // target chậm, mặc định 30s không đủ (đã thấy ws connected nhưng handshake quá hạn).
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl, { timeout: 120_000 });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  // Dùng tab MỚI (không giành tab tiktokstudio đang mở của lần trước → tránh modal "exit?").
  const page = await ctx.newPage();
  // Đóng bớt tab cũ để phiên nhẹ (giữ lại tab mới vừa mở).
  for (const p of ctx.pages()) { if (p !== page) await p.close().catch(() => {}); }
  page.on("dialog", (d: any) => d.accept().catch(() => {}));

  let step = "open";
  const result: PublishResult = { posted: false, dryRun: !!opts.dryRun, productLinked: false, caption: opts.caption, pilotLeft: -1 };
  const dbg = async (name: string) => { if (opts.debugShots) log(`   📸 ${await shot(page, opts.videoId, name)}`); };

  try {
    // ── Bước 1: mở Content Hub ──
    log(`📤 [1] Mở Content Hub (Seller Center)…`);
    await page.goto(CONTENT_HUB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(5000);
    await waitCaptcha(page, log);
    await dbg("01-hub");

    // Login check — Seller Center (KHÁC tiktok.com). Chưa login → có form login / redirect.
    step = "check-login";
    const loggedOut = await page.locator('text=/Log in|Sign in to.*Seller/i').first()
      .isVisible({ timeout: 4000 }).catch(() => false);
    if (loggedOut || /\/(login|account\/login)/i.test(page.url())) {
      const f = await shot(page, opts.videoId, "not-logged-in");
      throw new Error(
        `Profile Kiki chưa đăng nhập Seller Center (seller-us.tiktok.com). ` +
        `Mở profile trong Kiki → đăng nhập Seller Center của shop → chạy lại. Screenshot: ${f}`
      );
    }

    // ── Bước 2: "Post on TikTok" (header) → "Video post" ──
    // CHẬP CHỜN: mouse.click theo toạ độ đôi khi trượt (banner thông báo Seller Center bật lên
    // làm layout xê dịch giữa lúc đo toạ độ và lúc click → dropdown đóng, panel không mở).
    // → retry cả cụm: đảm bảo dropdown mở → click "Video post" (trusted) → chờ panel, tối đa 4 lần.
    step = "post-menu";
    log(`🎬 [2] Post on TikTok → Video post…`);
    // Toạ độ tâm item "Video post" đang HIỆN (item = <div role=menuitem><icon/>Video post</div>
    // → có children nên không lọc children===0). null nếu dropdown chưa mở.
    const findVideoPost = () => page.evaluate(() => {
      const matches = [...document.querySelectorAll("div,li,a,button,span,p")]
        .filter((el) => (el.textContent || "").trim() === "Video post")
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      for (const el of matches) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        if (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    // Item "Video post" đang HIỆN (Playwright locator, lọc visible để tránh node ẩn).
    const vpLoc = page.locator(':text-is("Video post")').locator("visible=true").first();
    let panelOpen = false;
    for (let attempt = 1; attempt <= 6 && !panelOpen; attempt++) {
      // đảm bảo dropdown mở
      if (!(await vpLoc.isVisible().catch(() => false))) {
        await page.locator('button:has-text("Post on TikTok"), div[role="button"]:has-text("Post on TikTok")')
          .first().click({ timeout: 15_000 }).catch(() => {});
        await sleep(1500);
      }
      if (attempt === 1) await dbg("02-menu");
      // Click ưu tiên Playwright (trusted, click actionable point + auto-scroll); fallback mouse.click toạ độ.
      const clicked = await vpLoc.click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (!clicked) { const b = await findVideoPost(); if (b) await page.mouse.click(b.x, b.y); }
      panelOpen = await page.locator('text=/Upload a shoppable video|Choose video/i').first()
        .waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
      if (!panelOpen) log(`   ↻ Panel chưa mở, thử lại (${attempt}/6)…`);
    }
    if (!panelOpen) { const f = await shot(page, opts.videoId, "no-upload-panel"); throw new Error(`Không mở được panel "Upload a shoppable video" sau 6 lần. Screenshot: ${f}`); }
    await sleep(1500);
    await dbg("03-upload-panel");

    // Đọc pilot quota nếu hiện.
    const pilotTxt = await page.locator('text=/shoppable videos? left to post/i').first()
      .innerText().catch(() => "");
    const m = pilotTxt.match(/(\d+)\s+of\s+(\d+)\s+shoppable/i);
    if (m) { result.pilotLeft = parseInt(m[1]); log(`   ℹ️ Pilot: còn ${m[1]}/${m[2]} shoppable video được đăng.`); }

    // ── Bước 3: chọn file ──
    // "Choose video" mở dialog file — input[type=file] có thể tạo ĐỘNG khi click, nên
    // dùng filechooser (bắt sự kiện) thay vì tìm input tĩnh. Fallback input tĩnh nếu có.
    step = "choose-video";
    let fileSet = false;
    try {
      const [fc] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15_000 }),
        page.locator('button:has-text("Choose video"), div[role="button"]:has-text("Choose video")')
          .first().click({ timeout: 10_000 }),
      ]);
      await fc.setFiles(opts.videoFile);
      fileSet = true;
    } catch {
      const fi = page.locator('input[type="file"]').first();
      if (await fi.count().catch(() => 0)) { await fi.setInputFiles(opts.videoFile); fileSet = true; }
    }
    if (!fileSet) { const f = await shot(page, opts.videoId, "no-file-input"); throw new Error(`Không chọn được file (không có filechooser lẫn input[type=file]). Screenshot: ${f}`); }
    log(`   ✓ [3] Đã chọn file ${path.basename(opts.videoFile)}`);
    await sleep(3000);
    await dbg("04-uploading");

    // ── Bước 4: chờ upload xong ──
    step = "upload-wait";
    log(`   ⏳ [4] Chờ upload xong (tối đa ${UPLOAD_WAIT_MS / 1000}s)…`);
    const t0 = Date.now();
    let uploaded = false;
    while (Date.now() - t0 < UPLOAD_WAIT_MS) {
      await sleep(3000);
      // Upload xong khi KHÔNG còn "Uploading" / progress %, và ô Description đã có mặt.
      const stillUploading = await page.locator('text=/Uploading/i').first().isVisible().catch(() => false);
      const descReady = await page.locator('textarea').first().isVisible().catch(() => false);
      if (!stillUploading && descReady) { uploaded = true; break; }
    }
    if (!uploaded) { const f = await shot(page, opts.videoId, "upload-timeout"); throw new Error(`Upload không xong sau ${UPLOAD_WAIT_MS / 1000}s. Screenshot: ${f}`); }
    log(`   ✓ Uploaded`);
    await dbg("05-uploaded");

    // ── Bước 5: Description + Hashtags ──
    step = "description";
    log(`✍️ [5] Điền description + hashtags…`);
    // Description: textarea có placeholder "Share more about..."; fallback textarea đầu tiên.
    let descBox = page.locator('textarea[placeholder*="Share more" i]').first();
    if (!(await descBox.count().catch(() => 0))) descBox = page.locator('textarea').first();
    await descBox.click();
    await descBox.fill(description);
    await sleep(500);
    const gotDesc = await descBox.inputValue().catch(() => "");
    if (normText(gotDesc) !== normText(description)) log(`   ⚠️ Description vào ${gotDesc.length}/${description.length} ký tự.`);
    log(`   ✓ Description: "${description.slice(0, 50)}…"`);

    // Hashtags: ô riêng — gõ từng tag + Enter để tạo chip.
    step = "hashtags";
    if (hashtags.length) {
      let tagBox = page.locator('textarea[placeholder*="hashtag" i], input[placeholder*="hashtag" i]').first();
      if (!(await tagBox.count().catch(() => 0))) {
        // fallback: textarea thứ 2 (sau description)
        tagBox = page.locator('textarea').nth(1);
      }
      await tagBox.click().catch(() => {});
      for (const tag of hashtags) {
        await page.keyboard.type(`#${tag}`, { delay: 40 });
        await sleep(300);
        await page.keyboard.press("Enter");
        await sleep(300);
      }
      log(`   ✓ Hashtags: ${hashtags.map((t) => "#" + t).join(" ")}`);
    }
    await dbg("06-text-filled");

    // ── Bước 6: Add product ──
    if (opts.skipProduct) {
      log(`⏭️ [6] BỎ QUA gắn sản phẩm (--skip-product)`);
    } else {
      step = "add-product";
      log(`🔗 [6] Add product ${opts.productId}…`);
      // CHẬP CHỜN như "Video post": banner onboarding của shop chưa setup đẩy layout →
      // nút "+ Add product" lệch/không actionable → click timeout. Retry: click nút (Playwright
      // trước, fallback mouse.click theo toạ độ) → chờ modal "Choose product", tối đa 4 lần.
      let productModalOpen = false;
      for (let attempt = 1; attempt <= 4 && !productModalOpen; attempt++) {
        const addBtn = page.locator('button:has-text("Add product"), div[role="button"]:has-text("Add product")').first();
        const clicked = await addBtn.click({ timeout: 6000 }).then(() => true).catch(() => false);
        if (!clicked) {
          // fallback: mouse.click theo toạ độ tâm nút (tránh vấn đề actionable/che khuất)
          const box = await page.evaluate(() => {
            const btn = [...document.querySelectorAll("button,div[role='button']")]
              .find((el) => /add product/i.test((el.textContent || "").trim()));
            if (!btn) return null;
            (btn as HTMLElement).scrollIntoView({ block: "center" });
            const r = (btn as HTMLElement).getBoundingClientRect();
            return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          });
          if (box) await page.mouse.click(box.x, box.y);
        }
        productModalOpen = await page.locator('text=/Choose product/i').first()
          .waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
        if (!productModalOpen) log(`   ↻ Modal Choose product chưa mở, thử lại (${attempt}/4)…`);
      }
      if (!productModalOpen) { const f = await shot(page, opts.videoId, "no-product-modal"); throw new Error(`Không mở được modal "Choose product" sau 4 lần. Screenshot: ${f}`); }
      await sleep(1000);
      await dbg("07-product-modal");

      // Modal "Choose product": search product_id
      step = "search-product";
      const searchBox = page.locator('input[placeholder*="Search product" i], input[placeholder*="product name or id" i]').first();
      await searchBox.waitFor({ state: "visible", timeout: 15_000 });
      await searchBox.fill(opts.productId);
      await sleep(400);
      // Nút kính lúp cạnh ô search; fallback Enter.
      const searchBtn = page.locator('[class*="search" i] button, button[class*="search" i]').first();
      if (await searchBtn.count().catch(() => 0)) await searchBtn.click({ timeout: 5000 }).catch(() => searchBox.press("Enter"));
      else await searchBox.press("Enter");
      await sleep(3000);
      await dbg("08-product-search");

      // Chọn radio dòng đúng product_id (DOM-agnostic: tìm text = pid, leo lên tìm radio)
      step = "select-product";
      const found = await page.locator(`text=/${opts.productId}/`).first()
        .waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
      if (!found) {
        const f = await shot(page, opts.videoId, "product-not-found");
        throw new Error(`Không tìm thấy product ${opts.productId} trong shop này (product thuộc shop khác / listing inactive). Screenshot: ${f}`);
      }
      // Chọn radio bằng CLICK CHUỘT THẬT tại toạ độ — Arco radio KHÔNG nhận synthetic
      // .click() (Confirm sẽ vẫn disabled). Tìm control radio trong dòng chứa product id,
      // nếu input bị ẩn (width 0) thì lấy label/wrapper bọc ngoài.
      const radioBox = await page.evaluate((pid: string) => {
        const idEl = [...document.querySelectorAll("*")].find(
          (el) => el.children.length === 0 && (el.textContent || "").trim() === pid
        );
        let row: HTMLElement | null = idEl as HTMLElement | null;
        for (let i = 0; i < 10 && row; i++) {
          if (row.querySelector('input[type="radio"],[class*="radio" i]')) break;
          row = row.parentElement;
        }
        const scope: ParentNode = row || document.body;
        let ctrl = (scope.querySelector('label[class*="radio" i]')
          || scope.querySelector('[class*="radio" i]')
          || scope.querySelector('input[type="radio"]')) as HTMLElement | null;
        if (!ctrl) return null;
        if (ctrl.getBoundingClientRect().width === 0) {
          ctrl = (ctrl.closest('label,[class*="radio" i]') as HTMLElement) || ctrl.parentElement || ctrl;
        }
        const r = ctrl.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, opts.productId);
      if (!radioBox) { const f = await shot(page, opts.videoId, "radio-not-found"); throw new Error(`Thấy product ${opts.productId} nhưng không tìm được radio để click. Screenshot: ${f}`); }
      await page.mouse.click(radioBox.x, radioBox.y);
      await sleep(1000);
      // Confirm trong modal (click thật auto-chờ enabled; radio đã chọn → nút bật)
      await page.locator('button:has-text("Confirm")').last().click({ timeout: 15_000 });
      log(`   ✓ [6] Chọn sản phẩm + Confirm`);
      await sleep(3000);
      await dbg("09-product-added");
      result.productLinked = true;
    }

    // ── Bước 7: Post ──
    step = "post";
    await waitCaptcha(page, log);
    if (opts.dryRun) {
      const f = await shot(page, opts.videoId, "dryrun-before-post");
      log(`🧪 [7] DRY-RUN: DỪNG trước nút "Post on TikTok" (KHÔNG tốn pilot quota). Screenshot: ${f}`);
      log(`   → Soi cửa sổ Kiki: description, hashtag, sản phẩm đã đúng chưa. Giữ 60s.`);
      await sleep(60_000);
      return result;
    }
    log(`🚀 [7] Post on TikTok…`);
    // Nút footer submit "Post on TikTok" (nút cuối trong DOM, KHÁC nút header).
    const postBtn = page.locator('button:has-text("Post on TikTok")').last();
    await postBtn.waitFor({ state: "visible", timeout: 20_000 });
    // Chờ nút enabled (TikTok chạy checks / cover đang render).
    const enabled = async (): Promise<boolean> =>
      postBtn.evaluate((el: HTMLButtonElement) => {
        const st = getComputedStyle(el);
        return !el.disabled && el.getAttribute("aria-disabled") !== "true"
          && !/disabled/i.test(el.className) && st.pointerEvents !== "none";
      }).catch(() => false);
    const tp = Date.now();
    while (Date.now() - tp < 120_000) { if (await enabled()) break; await sleep(2000); }
    if (!(await enabled())) { const f = await shot(page, opts.videoId, "post-btn-disabled"); throw new Error(`Nút "Post on TikTok" vẫn disabled sau 120s. Screenshot: ${f}`); }

    await postBtn.click({ timeout: 20_000 });
    log(`   ✓ Đã bấm Post on TikTok — chờ xác nhận…`);

    // ── Xác nhận THẬT: dialog "Your video has been posted" ──
    step = "confirm-posted";
    const confirmed = await page.locator('text=/Your video has been posted/i').first()
      .waitFor({ state: "visible", timeout: 90_000 }).then(() => true).catch(() => false);
    await dbg("10-after-post");
    if (!confirmed) {
      const f = await shot(page, opts.videoId, "post-no-confirm");
      throw new Error(`Bấm Post nhưng KHÔNG thấy dialog "Your video has been posted". Screenshot: ${f}`);
    }
    result.posted = true;
    log(`✅ Đăng thành công video #${opts.videoId} (TikTok xác nhận "Your video has been posted")`);

    if (opts.holdAfterPostMs) {
      log(`   ⏸️ GIỮ MÀN HÌNH ${Math.round(opts.holdAfterPostMs / 1000)}s để soi.`);
      await sleep(opts.holdAfterPostMs);
      await shot(page, opts.videoId, "after-hold");
    }

    // Đóng dialog bằng "Open TikTok" (hoặc X) để phiên sạch cho lần sau.
    await clickIfVisible(page, 'button:has-text("Open TikTok")', 4000, log, "Open TikTok (đóng dialog)");
    return result;
  } catch (e: any) {
    const f = await shot(page, opts.videoId, step);
    throw new Error(`[bước ${step}] ${e?.message ?? e} (screenshot: ${f})`);
  } finally {
    await browser.close().catch(() => {});
    await kiki.forceStop(opts.profileId).catch(() => {});
    log(`🔌 Đã đóng Kiki profile.`);
  }
}
