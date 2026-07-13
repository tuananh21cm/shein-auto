/**
 * publishVideo — auto đăng 1 video lên TikTok Studio qua Kiki profile của shop.
 *
 * Flow (đúng 10 bước UI TikTok Studio, xem docs ảnh trong session 2026-07-13):
 *   1. Mở /tiktokstudio/upload → setInputFiles vào input[type=file] (KHÔNG click "Select videos"
 *      vì Playwright không điều khiển được dialog file của Windows).
 *   2. Dialog "Turn on automatic content checks?" → Turn on   (OPTIONAL, không phải lúc nào cũng hiện)
 *   3. Tooltip "Preview your video on your phone" → Got it     (OPTIONAL)
 *   4. Description: xóa placeholder (tên file) → gõ caption + hashtag.
 *   5. Add link → nút "+ Add"
 *   6. Link type = Products (mặc định) → Next
 *   7. Điền product_id vào ô search → click kính lúp → chờ kết quả
 *   8. Chọn radio dòng đúng product_id → Next
 *   9. Dialog "Product name" → Add → chờ tag sản phẩm hiện
 *  10. Post
 *
 * Mỗi bước fail → screenshot data/screenshots/publish-<videoId>-<step>.png + throw kèm tên bước.
 * Captcha hiện → CHỜ user giải (giống tiktokAutoEdit), quá hạn thì fail bước đó.
 */
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../../services/kiki/client";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=creator_center";
const SHOT_DIR = path.resolve(process.cwd(), "data", "screenshots");
const UPLOAD_WAIT_MS = 240_000;   // video 20MB upload + xử lý
const CAPTCHA_WAIT_MS = 180_000;  // chờ user giải captcha

export interface PublishOptions {
  profileId: string;
  videoId: number;
  videoFile: string;
  caption: string;
  productId: string;
  /** true = làm hết TRỪ nút Post (test an toàn). */
  dryRun?: boolean;
  /** Bỏ qua bước gắn sản phẩm (dùng khi test chéo shop, product không thuộc shop đang login). */
  skipProduct?: boolean;
  onLog?: (m: string) => void;
}

export interface PublishResult {
  posted: boolean;
  dryRun: boolean;
  productLinked: boolean;
  caption: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Captcha ĐANG CHẶN (node visible + đủ to; TikTok preload node ẩn 0x0 → không tính). */
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

/** Chờ user giải captcha nếu có. Throw nếu quá hạn. */
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

async function shot(page: any, videoId: number, step: string): Promise<string> {
  await fs.ensureDir(SHOT_DIR);
  const file = path.join(SHOT_DIR, `publish-${videoId}-${step}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

/** Click element nếu nó XUẤT HIỆN trong waitMs; không hiện → bỏ qua (dialog optional). */
async function clickIfVisible(page: any, selector: string, waitMs: number, log: (m: string) => void, label: string): Promise<boolean> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: "visible", timeout: waitMs });
    await loc.click({ timeout: 5000 });
    log(`   ✓ ${label}`);
    await sleep(700);
    return true;
  } catch {
    log(`   – ${label}: không hiện, bỏ qua`);
    return false;
  }
}

/** Chuẩn hóa để so sánh nội dung editor với caption (bỏ khác biệt whitespace/xuống dòng). */
const normText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Điền Description. Editor là contenteditable (DraftJS) và NUỐT KÝ TỰ khi gõ nhanh
 * (đã thấy thật: caption 207 ký tự chỉ vào 179, cụt giữa từ). Nên: gõ chậm → ĐỌC LẠI
 * nội dung editor → thiếu thì xóa gõ lại (tối đa 3 lần), lần cuối dùng insertText (chèn
 * 1 phát qua CDP, không mô phỏng phím).
 */
async function typeCaption(page: any, caption: string, log: (m: string) => void): Promise<void> {
  const editor = page.locator('div[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  const lines = caption.split("\n");

  for (let attempt = 1; attempt <= 3; attempt++) {
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await sleep(500);

    if (attempt < 3) {
      for (let i = 0; i < lines.length; i++) {
        await page.keyboard.type(lines[i], { delay: 70 }); // 25ms nuốt ký tự → 70ms
        await sleep(700);
        await page.keyboard.press("Escape").catch(() => {}); // đóng dropdown gợi ý hashtag
        await sleep(300);
        if (i < lines.length - 1) await page.keyboard.press("Enter");
      }
    } else {
      // Fallback: chèn thẳng, không mô phỏng phím (không bị nuốt, nhưng không trigger dropdown tag)
      await page.keyboard.insertText(caption);
      await sleep(1000);
      log(`   ↻ Dùng insertText (fallback lần 3)`);
    }

    await sleep(800);
    const got = await editor.innerText().catch(() => "");
    if (normText(got) === normText(caption)) return;
    log(`   ⚠️ Caption vào thiếu (${got.length}/${caption.length} ký tự) — gõ lại (${attempt}/3)`);
  }
  const got = await editor.innerText().catch(() => "");
  throw new Error(`Không điền được caption đầy đủ sau 3 lần (chỉ vào ${got.length}/${caption.length} ký tự)`);
}

export async function publishVideo(opts: PublishOptions): Promise<PublishResult> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  if (!(await fs.pathExists(opts.videoFile))) throw new Error(`Không thấy file video: ${opts.videoFile}`);

  log(`🔌 Kiki profile ${opts.profileId} — force stop + start…`);
  await kiki.forceStop(opts.profileId);
  const started = await kiki.startWithRetry(opts.profileId, (m) => log("   " + m));
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  let step = "open";
  const result: PublishResult = { posted: false, dryRun: !!opts.dryRun, productLinked: false, caption: opts.caption };

  try {
    // ── Bước 1: mở upload + set file ──
    log(`📤 [1] Mở TikTok Studio upload…`);
    await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(3000);
    await waitCaptcha(page, log);

    // Profile Kiki có thể CHƯA login tiktok.com (login Seller Center là phiên KHÁC).
    // Bắt sớm để báo rõ, không phải đợi timeout tìm input file.
    step = "check-login";
    const loggedOut = await page.locator('text=/Log in to TikTok/i').first()
      .isVisible({ timeout: 5000 }).catch(() => false);
    if (loggedOut || /\/login/i.test(page.url())) {
      const f = await shot(page, opts.videoId, "not-logged-in");
      throw new Error(
        `Profile Kiki chưa đăng nhập tiktok.com (đang ở màn "Log in to TikTok"). ` +
        `Mở profile trong Kiki → vào tiktok.com → đăng nhập tài khoản TikTok của shop → chạy lại. ` +
        `Lưu ý: login Seller Center KHÁC login tiktok.com. Screenshot: ${f}`
      );
    }

    step = "select-file";
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(opts.videoFile);
    log(`   ✓ Đã chọn file ${path.basename(opts.videoFile)}`);

    // ── Bước 2-3: dialog optional ──
    step = "dialogs";
    await clickIfVisible(page, 'button:has-text("Turn on")', 12_000, log, "[2] Turn on content checks");
    await clickIfVisible(page, 'button:has-text("Got it")', 8_000, log, "[3] Got it (tooltip preview)");

    // ── Chờ upload xong ──
    step = "upload-wait";
    log(`   ⏳ Chờ upload xong (tối đa ${UPLOAD_WAIT_MS / 1000}s)…`);
    await page.locator('text=/Uploaded/i').first().waitFor({ state: "visible", timeout: UPLOAD_WAIT_MS });
    log(`   ✓ Uploaded`);
    // dialog có thể hiện MUỘN sau khi upload xong
    await clickIfVisible(page, 'button:has-text("Turn on")', 4000, log, "[2b] Turn on (hiện muộn)");
    await clickIfVisible(page, 'button:has-text("Got it")', 3000, log, "[3b] Got it (hiện muộn)");

    // ── Bước 4: Description ──
    step = "description";
    log(`✍️ [4] Điền description…`);
    await typeCaption(page, opts.caption, log);
    log(`   ✓ Caption: "${opts.caption.split("\n")[0].slice(0, 50)}…"`);

    // ── Bước 5-9: gắn link sản phẩm ──
    if (opts.skipProduct) {
      log(`⏭️ [5-9] BỎ QUA gắn sản phẩm (--skip-product)`);
    } else {
      step = "add-link";
      log(`🔗 [5] Add link → chọn sản phẩm ${opts.productId}…`);
      // Nút "+ Add" nằm dưới label "Add link" (KHÔNG dùng :has-text("Add") chung — trùng nút khác)
      const addBtn = page.locator('button:has-text("Add"), div[role="button"]:has-text("Add")')
        .filter({ hasNotText: /Add link/i }).first();
      await addBtn.scrollIntoViewIfNeeded().catch(() => {});
      await addBtn.click({ timeout: 15_000 });
      await sleep(1200);

      step = "link-type-next";
      // [6] Dialog "Add link" — Link type mặc định Products → Next
      await page.locator('button:has-text("Next")').first().click({ timeout: 15_000 });
      log(`   ✓ [6] Next (link type = Products)`);
      await sleep(1500);

      step = "search-product";
      // [7] Ô search + nút kính lúp
      const searchBox = page.locator('input[placeholder], input[type="text"]').last();
      await searchBox.waitFor({ state: "visible", timeout: 20_000 });
      await searchBox.fill(opts.productId);
      await sleep(300);
      // Nút kính lúp cạnh ô search; fallback Enter nếu không tìm được nút.
      const searchBtn = page.locator('[class*="search"] button, button[class*="search"], svg[class*="search"]').first();
      if (await searchBtn.count().catch(() => 0)) await searchBtn.click({ timeout: 5000 }).catch(() => searchBox.press("Enter"));
      else await searchBox.press("Enter");
      log(`   ✓ [7] Tìm product ${opts.productId}`);
      await sleep(3000);

      step = "select-product";
      // [8] Radio của dòng CÓ ĐÚNG product id (verify tránh chọn nhầm dòng)
      const row = page.locator(`tr:has-text("${opts.productId}"), div[class*="row"]:has-text("${opts.productId}")`).first();
      if (!(await row.count().catch(() => 0))) {
        const f = await shot(page, opts.videoId, "product-not-found");
        throw new Error(`Không tìm thấy product ${opts.productId} trong shop này (có thể product thuộc shop khác). Screenshot: ${f}`);
      }
      const radio = row.locator('input[type="radio"], [class*="radio"]').first();
      await radio.click({ timeout: 10_000 });
      await sleep(800);
      await page.locator('button:has-text("Next")').last().click({ timeout: 15_000 });
      log(`   ✓ [8] Chọn sản phẩm + Next`);
      await sleep(3000);

      step = "confirm-add";
      // [9] Dialog "Product name" → Add
      await page.locator('button:has-text("Add")').last().click({ timeout: 20_000 });
      log(`   ✓ [9] Add — chờ gắn link…`);
      await sleep(5000);
      result.productLinked = true;
    }

    // ── Bước 10: Post ──
    step = "post";
    await waitCaptcha(page, log);
    if (opts.dryRun) {
      const f = await shot(page, opts.videoId, "dryrun-before-post");
      log(`🧪 [10] DRY-RUN: DỪNG trước nút Post. Screenshot: ${f}`);
      log(`   → Kiểm tra cửa sổ Kiki: caption, sản phẩm đã gắn đúng chưa. Browser giữ mở 60s.`);
      await sleep(60_000);
      return result;
    }
    log(`🚀 [10] Post…`);
    await page.locator('button:has-text("Post")').first().click({ timeout: 20_000 });
    // Xác nhận đăng: TikTok chuyển sang trang Posts / hiện toast thành công
    await page.locator('text=/Your video is being uploaded|Manage your posts|posted|Post scheduled/i')
      .first().waitFor({ state: "visible", timeout: 90_000 })
      .catch(async () => {
        // Không thấy confirm rõ ràng → check URL đổi khỏi trang upload
        await sleep(8000);
        if (/\/upload/i.test(page.url())) {
          const f = await shot(page, opts.videoId, "post-no-confirm");
          throw new Error(`Bấm Post nhưng không thấy xác nhận đăng. Screenshot: ${f}`);
        }
      });
    result.posted = true;
    log(`✅ Đăng thành công video #${opts.videoId}`);
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
