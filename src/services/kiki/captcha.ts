/**
 * Xử lý captcha SHEIN khi cào bằng Kiki.
 *
 * Chiến lược layered:
 *  1. Phòng ngừa: warm-up + human pacing (ở orchestrator/scraper).
 *  2. Phát hiện: URL /risk/challenge hoặc element captcha.
 *  3. Giải:
 *     - mode "manual" (mặc định): phát hiện → log cảnh báo → CHỜ user kéo
 *       slider trong cửa sổ Kiki → tự nhận diện đã xong → tiếp tục.
 *     - mode "capsolver" (tùy chọn): hook gọi CapSolver (chưa bật mặc định).
 */
import type { Page } from "playwright-core";
import sharp from "sharp";
import { notifyCaptcha } from "../notification/telegram";

export interface CaptchaOptions {
  mode?: "manual" | "capsolver";
  /** Thời gian tối đa chờ giải (ms). Mặc định 3 phút. */
  waitTimeoutMs?: number;
  capsolverApiKey?: string;
  /** Mô tả việc đang làm (để báo Telegram), vd "Cào store P5-022". */
  context?: string;
  /** profileId Kiki (để báo Telegram biết profile nào). */
  profileId?: string;
  onLog?: (msg: string) => void;
}

/** Phát hiện trang đang ở captcha / risk challenge. */
export async function isCaptchaPresent(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/risk\/challenge|\/captcha|geetest|robot|verify-?human/i.test(url)) return true;
    // Element captcha phổ biến (GeeTest slider + Cloudflare Turnstile "I am human" + iframe captcha)
    const count = await page
      .locator(
        [
          'iframe[src*="captcha" i]',
          'iframe[src*="challenges.cloudflare.com" i]',
          'iframe[src*="cloudflare" i]',
          'iframe[src*="turnstile" i]',
          ".geetest_holder",
          ".geetest_panel",
          ".geetest_box",
          '[class*="captcha" i][class*="slider" i]',
          '[class*="verify" i] [class*="slider" i]',
          '[id*="captcha" i]',
          '[class*="turnstile" i]',
          "#cf-turnstile",
        ].join(", ")
      )
      .count()
      .catch(() => 0);
    if (count > 0) return true;
    // Cloudflare/SHEIN dạng text "verify you are human" / "I am human" (modal không có class captcha rõ)
    const textHit = await page
      .getByText(/verify you are human|i\s*am\s*human|complete the following actions/i)
      .count()
      .catch(() => 0);
    return textHit > 0;
  } catch {
    return false;
  }
}

/**
 * Đảm bảo không còn captcha trước khi tiếp tục. Nếu có:
 *  - manual: chờ user giải (poll tới khi hết hoặc timeout).
 *  - capsolver: (TODO) gọi solver; hiện fallback sang chờ manual.
 * Throw nếu hết timeout vẫn còn captcha.
 */
export async function ensureNoCaptcha(page: Page, opts: CaptchaOptions = {}): Promise<void> {
  const log = opts.onLog ?? (() => {});
  if (!(await isCaptchaPresent(page))) return;

  const timeout = opts.waitTimeoutMs ?? 180_000;
  const apiKey = opts.capsolverApiKey || process.env.CAPSOLVER_API_KEY || "";

  log(`⚠️ Captcha — ${apiKey ? "CapSolver tự giải GeeTest" : "chờ giải thủ công"}. Nếu hiện 'I am human' mà tự click không qua → sếp click 1 cái trong Kiki.`);
  notifyCaptcha({
    context: opts.context ?? "Cào SHEIN bằng Kiki",
    profileId: opts.profileId,
    url: (() => { try { return page.url(); } catch { return undefined; } })(),
  }).catch(() => {});

  // GeeTest panel xuất hiện CHƯA? (tầng 2 — sau khi qua "I am human")
  const hasGeetest = async () =>
    (await page.locator(".geetest_panel_box, .geetest_panel, .captcha_click_wrapper").first().count().catch(() => 0)) > 0;

  const start = Date.now();
  let lastLog = 0;
  let capAttempts = 0;
  while (Date.now() - start < timeout) {
    if (!(await isCaptchaPresent(page))) {
      log("✅ Captcha đã qua — tiếp tục.");
      await page.waitForTimeout(2000);
      return;
    }
    if (apiKey && (await hasGeetest())) {
      // Tầng GeeTest → CapSolver thử 2 lần. Lỗi "targets<3" (loại icon-sequence 909) là DETERMINISTIC
      // → thử quá vô ích, fail-fast sang chờ thủ công (KHÔNG can thiệp để sếp click được).
      if (capAttempts < 2) {
        capAttempts++;
        log(`🤖 CapSolver giải GeeTest (lần ${capAttempts})…`);
        const solved = await trySolveWithCapsolver(page, { ...opts, capsolverApiKey: apiKey }).catch((e) => {
          log(`CapSolver lỗi: ${e?.message ?? e}`);
          return false;
        });
        if (solved && !(await isCaptchaPresent(page))) {
          log("✅ CapSolver giải xong.");
          await page.waitForTimeout(1500);
          return;
        }
      }
    } else {
      // Tầng "I am human" (chưa có GeeTest) → thử tự click để mở GeeTest.
      await clickHuman(page).catch(() => {});
    }
    await page.waitForTimeout(2500);
    if (Date.now() - lastLog > 20_000) {
      lastLog = Date.now();
      log(`Chờ captcha… (${Math.round((Date.now() - start) / 1000)}s)`);
    }
  }
  throw new Error("Hết thời gian chờ giải captcha (chưa giải xong).");
}

/**
 * "X" (đóng) popup captcha rồi cào tiếp — KHÔNG chờ giải, KHÔNG noti Telegram.
 * Dùng cho cào Chrome: phần lớn captcha SHEIN là modal/overlay có nút đóng; đóng xong product vẫn ở DOM dưới.
 * Thử: click nút close (main DOM + iframe) → Escape → gỡ overlay khỏi DOM (last resort).
 * Trả true nếu sau khi đóng KHÔNG còn captcha (URL-block thì không X được → false, để caller bỏ qua sp).
 */
export async function dismissCaptcha(page: Page, log: (m: string) => void = () => {}): Promise<boolean> {
  if (!(await isCaptchaPresent(page).catch(() => false))) return true;

  const closeSelectors = [
    ".geetest_close", ".geetest_panel_close", ".geetest_panel .geetest_close",
    ".captcha_close", ".captcha_click_close", ".secsdk-captcha-close-button",
    ".she-close-external", ".modal-header__close", ".f-close",
    '[class*="captcha" i] [class*="close" i]', '[class*="verify" i] [class*="close" i]',
    '[class*="geetest" i] [class*="close" i]', '[aria-label="Close" i]', '[aria-label="close" i]',
  ];

  for (let round = 0; round < 2; round++) {
    let clicked = false;
    for (const sel of closeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ timeout: 1500, force: true }).catch(() => {}); clicked = true; }
      } catch { /* next */ }
    }
    // Nút đóng nằm trong iframe captcha (Cloudflare/turnstile/secsdk).
    for (const fsel of ['iframe[src*="captcha" i]', 'iframe[src*="secsdk" i]', 'iframe[src*="verify" i]']) {
      try {
        const x = page.frameLocator(fsel).locator('[class*="close" i], [aria-label*="close" i]').first();
        if (await x.count()) { await x.click({ timeout: 1500 }).catch(() => {}); clicked = true; }
      } catch { /* next */ }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
    if (!(await isCaptchaPresent(page).catch(() => false))) { log("✅ Đã X captcha — cào tiếp."); return true; }
    if (!clicked) break; // không thấy nút đóng nào → khỏi lặp vô ích
  }

  // Last resort: gỡ overlay/holder captcha khỏi DOM (nhiều captcha chỉ là lớp che, gỡ là lộ product dưới).
  try {
    await page.evaluate(() => {
      const sels = ['.geetest_holder', '.geetest_panel', '.geetest_box', '.captcha_click_wrapper',
        '[class*="captcha" i][class*="mask" i]', '[class*="captcha" i][class*="overlay" i]', '[class*="captcha" i][class*="modal" i]'];
      for (const s of sels) document.querySelectorAll(s).forEach((n) => n.remove());
    });
  } catch { /* ignore */ }
  const gone = !(await isCaptchaPresent(page).catch(() => false));
  log(gone ? "✅ Đã gỡ overlay captcha — cào tiếp." : "⚠️ Captcha dạng chặn URL — không X được, bỏ qua sp này.");
  return gone;
}

/** Click checkbox "I am human" (gateway trước GeeTest). Thử main DOM + iframe. */
async function clickHuman(page: Page): Promise<void> {
  const tries = [
    () => page.getByText(/^\s*i\s*am\s*human\s*$/i).first(),
    () => page.locator('label:has-text("I am human")').first(),
    () => page.locator('[class*="verify" i] input[type="checkbox"], [class*="human" i] input[type="checkbox"], [class*="captcha" i] input[type="checkbox"]').first(),
  ];
  for (const t of tries) {
    try { const el = t(); if (await el.count()) { await el.click({ timeout: 2000 }); return; } } catch { /* next */ }
  }
  for (const sel of ['iframe[src*="cloudflare" i]', 'iframe[src*="turnstile" i]', 'iframe[src*="captcha" i]']) {
    try {
      const fl = page.frameLocator(sel);
      const cb = fl.getByText(/i\s*am\s*human|verify/i).first();
      if (await cb.count()) { await cb.click({ timeout: 2000 }); return; }
      const inp = fl.locator('input[type="checkbox"]').first();
      if (await inp.count()) { await inp.click({ timeout: 2000 }); return; }
    } catch { /* next */ }
  }
}

/**
 * Giải captcha GeeTest/SHEIN qua CapSolver VisionEngine module "shein":
 *  1. Screenshot panel captcha → base64.
 *  2. createTask {type:VisionEngine, module:"shein", image, question} → trả rects (toạ độ ô cần click).
 *  3. Map toạ độ ảnh → toạ độ trang, Playwright click từng ô theo thứ tự + click Confirm.
 * Trả true nếu captcha biến mất sau khi giải.
 */
async function trySolveWithCapsolver(page: Page, opts: CaptchaOptions): Promise<boolean> {
  const apiKey = opts.capsolverApiKey;
  if (!apiKey) return false;

  // 1. Element panel captcha — ƯU TIÊN .geetest_panel_box (box chứa ẢNH GRID + icon mẫu),
  //    KHÔNG dùng .geetest_panel (wrapper ngoài, không có ảnh).
  let panel = page.locator(".geetest_panel_box").first();
  if (!(await panel.count().catch(() => 0))) panel = page.locator(".captcha_click_wrapper, .geetest_widget, .geetest_box").first();
  if (!(await panel.count().catch(() => 0))) return false;
  const box = await panel.boundingBox();
  if (!box) return false;
  const shot = await panel.screenshot().catch(() => null);
  if (!shot) return false;
  const meta = await sharp(shot).metadata();
  const imgW = meta.width ?? Math.round(box.width);
  const imgH = meta.height ?? Math.round(box.height);
  const scaleX = imgW / box.width;
  const scaleY = imgH / box.height;

  // Câu lệnh hiển thị trên captcha (vd "select all images according to the icon"); fallback mặc định.
  const question =
    (await page.locator(".captcha_click_tips_box, .geetest_tip").first().innerText({ timeout: 1500 }).catch(() => "")).trim() ||
    "Please select the following graphics in order";

  // 2. Gọi CapSolver (đồng bộ — solution trả ngay).
  const r = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "VisionEngine", module: "shein", image: shot.toString("base64"), question, websiteURL: (() => { try { return page.url(); } catch { return undefined; } })() },
    }),
  });
  const j: any = await r.json().catch(() => null);
  if (!j || j.errorId !== 0) { opts.onLog?.(`CapSolver lỗi: ${j?.errorCode || "?"} — ${j?.errorDescription || ""} (ảnh ${imgW}x${imgH}, q="${question.slice(0, 40)}")`); return false; }
  const rects: { x1: number; y1: number; x2: number; y2: number }[] = j.solution?.rects || j.solution?.boxes || [];
  if (!rects.length) { opts.onLog?.("CapSolver không trả toạ độ (rects rỗng)."); return false; }

  // 3. Click từng ô theo thứ tự (toạ độ ảnh → toạ độ trang CSS).
  for (const rc of rects) {
    const cx = box.x + ((rc.x1 + rc.x2) / 2) / scaleX;
    const cy = box.y + ((rc.y1 + rc.y2) / 2) / scaleY;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(350 + Math.floor(Math.random() * 300));
  }
  // 4. Nút Confirm.
  const confirm = page.locator(".captcha_click_confirm, .geetest_commit, .geetest_submit, [class*='confirm' i]").first();
  if (await confirm.count().catch(() => 0)) await confirm.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2200);

  return !(await isCaptchaPresent(page));
}
