import fs from "fs-extra";
import path from "path";

export interface PublishOutcome {
  ok: boolean;
  reason: string;
  finalUrl: string;
  screenshotPath?: string;
}

const SCREENSHOT_DIR = path.resolve(process.cwd(), "data", "screenshots");

/**
 * Element Plus `.el-message--error` là toast auto-dismiss (~3s). 4Seller bắn
 * nhiều toast transient lúc đang fill form (vd "Please select a variation
 * attribute") mặc dù không phải lỗi thật. Để giảm false positive, sau khi
 * thấy toast, đợi `confirmDelayMs` rồi check lại — nếu vẫn còn = lỗi thật.
 */
const isPersistentError = async (
  page: any,
  selector: string,
  confirmDelayMs: number
): Promise<string | null> => {
  const loc = page.locator(selector).first();
  if (!(await loc.isVisible({ timeout: 200 }).catch(() => false))) return null;
  const firstText = ((await loc.textContent({ timeout: 500 }).catch(() => "")) ?? "").trim();
  if (!firstText) return null;

  // Đợi xem có biến mất không
  await page.waitForTimeout(confirmDelayMs);

  // Re-check: dùng locator mới để tránh stale handle
  const recheck = page.locator(selector).first();
  if (!(await recheck.isVisible({ timeout: 200 }).catch(() => false))) {
    return null; // toast đã tắt → transient, OK
  }
  const finalText = ((await recheck.textContent({ timeout: 500 }).catch(() => "")) ?? "").trim();
  return finalText || firstText;
};

/**
 * Kiểm tra error đang hiển thị trên page.
 *
 * @param includeInline true = check cả `.el-form-item__error` inline.
 *   Inline error luôn hiện cho field bắt buộc chưa fill, nên chỉ check
 *   sau khi đã click publish.
 * @returns text của error đầu tiên gặp, hoặc null.
 */
export const checkPageErrors = async (
  page: any,
  includeInline: boolean = false
): Promise<string | null> => {
  // .el-message: toast 3s auto-dismiss → đợi 1500ms để loại transient
  // .el-notification: persistent → check ngay
  // .el-form-item__error: inline persistent → check ngay
  const toastSelectors = [".el-message--error"];
  const persistentSelectors = [".el-notification--error"];
  if (includeInline) persistentSelectors.push(".el-form-item__error");

  for (const sel of toastSelectors) {
    const txt = await isPersistentError(page, sel, 1500);
    if (txt) return `${sel}: ${txt}`;
  }
  for (const sel of persistentSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
        const txt = (await loc.textContent({ timeout: 500 }).catch(() => "")) ?? "";
        const trimmed = txt.trim();
        if (trimmed) {
          // Inline error: kèm label của field để biết NGAY field nào trống
          // (thay vì "Can not be empty" mù mờ).
          if (sel === ".el-form-item__error") {
            const label = await loc
              .evaluate((el: HTMLElement) => {
                const item = el.closest(".el-form-item");
                const lbl = item?.querySelector(".el-form-item__label");
                return lbl?.textContent?.trim() || "";
              })
              .catch(() => "");
            if (label) return `${sel}: [${label}] ${trimmed}`;
          }
          return `${sel}: ${trimmed}`;
        }
      }
    } catch {
      // tiếp tục
    }
  }
  return null;
};

/**
 * Scroll error element đầu tiên vào viewport trước khi chụp screenshot.
 * 4Seller create page cuộn trong container nội bộ nên fullPage screenshot
 * KHÔNG capture ngoài viewport — không scroll thì screenshot không thấy lỗi.
 */
export const scrollFirstErrorIntoView = async (page: any): Promise<void> => {
  try {
    const err = page
      .locator(".el-form-item__error, .el-notification--error, .el-message--error")
      .first();
    if (await err.isVisible({ timeout: 200 }).catch(() => false)) {
      await err.scrollIntoViewIfNeeded({ timeout: 2000 });
      await page.waitForTimeout(300);
    }
  } catch {
    // best-effort, không chặn việc chụp screenshot
  }
};

/**
 * Chụp screenshot full page rồi return path. Dùng cho debug khi listing fail.
 */
export const captureScreenshot = async (page: any, label: string): Promise<string | null> => {
  try {
    await fs.ensureDir(SCREENSHOT_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SCREENSHOT_DIR, `${ts}_${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (err) {
    console.warn("⚠️ Không chụp được screenshot:", err);
    return null;
  }
};

/**
 * Click Save & Publish rồi quan sát outcome trong timeoutMs.
 *
 * Phân loại:
 *  - SUCCESS  : URL rời khỏi /create.html, hoặc xuất hiện success toast → chờ URL change
 *  - FAIL     : .el-message--error / .el-notification--error / .el-form-item__error
 *  - TIMEOUT  : sau timeout vẫn còn ở create page, không toast nào — coi như fail
 */
export const detectPublishOutcome = async (
  page: any,
  opts?: { dryRun?: boolean; saveDraft?: boolean; timeoutMs?: number }
): Promise<PublishOutcome> => {
  const timeoutMs = opts?.timeoutMs ?? 90_000;

  if (opts?.dryRun) {
    return {
      ok: true,
      reason: "dryRun=true, không click Save & Publish",
      finalUrl: page.url(),
    };
  }

  // saveDraft: click nút "Save" (lưu NHÁP) thay vì "Save & Publish" — để test giai
  // đoạn đầu, không đăng live. Nút Save khác Save&Publish ở chỗ KHÔNG có btn-type=primary
  // → match theo accessible name "Save" (exact) để khỏi trúng "Save & Publish".
  if (opts?.saveDraft) {
    const saveBtn = page.getByRole("button", { name: "Save", exact: true }).first();
    try {
      await saveBtn.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      const sc = await captureScreenshot(page, "no-save-button");
      return { ok: false, reason: "Không thấy nút Save (draft)", finalUrl: page.url(), screenshotPath: sc ?? undefined };
    }
    const draftDisabled = await saveBtn
      .evaluate((el: HTMLElement) => el.classList.contains("is-disabled") || (el as HTMLButtonElement).disabled)
      .catch(() => false);
    if (draftDisabled) {
      const sc = await captureScreenshot(page, "save-disabled");
      return { ok: false, reason: "Nút Save (draft) đang disabled (form chưa hợp lệ)", finalUrl: page.url(), screenshotPath: sc ?? undefined };
    }
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    console.log("🖱️ Đã click Save (LƯU NHÁP), đợi outcome...");

    const draftTimeout = opts?.timeoutMs ?? 30_000;
    const draftStart = Date.now();
    while (Date.now() - draftStart < draftTimeout) {
      if (page.isClosed()) return { ok: false, reason: "Page bị đóng sau khi Save", finalUrl: "" };
      const errMsg = await checkPageErrors(page, true);
      if (errMsg) {
        await scrollFirstErrorIntoView(page);
        const sc = await captureScreenshot(page, "save-error");
        return { ok: false, reason: errMsg, finalUrl: page.url(), screenshotPath: sc ?? undefined };
      }
      const successToast = page.locator(".el-message--success, .el-notification--success").first();
      if (await successToast.isVisible({ timeout: 200 }).catch(() => false)) {
        const txt = ((await successToast.textContent().catch(() => "")) ?? "").trim();
        console.log(`✅ Đã lưu nháp: ${txt}`);
        return { ok: true, reason: `Lưu nháp (draft) OK: ${txt}`, finalUrl: page.url() };
      }
      if (!page.url().includes("/create.html")) {
        return { ok: true, reason: `Lưu nháp OK, chuyển ${page.url()}`, finalUrl: page.url() };
      }
      await page.waitForTimeout(500);
    }
    // Hết timeout mà không lỗi → coi như đã lưu nháp (draft thường chỉ toast nhanh).
    return { ok: true, reason: "Đã click Save (draft), không thấy lỗi", finalUrl: page.url() };
  }

  // 1. Click button. Nếu không thấy/không enabled → fail luôn.
  const publishBtn = page.locator("button:has-text('Save & Publish')").first();
  try {
    await publishBtn.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    const sc = await captureScreenshot(page, "no-publish-button");
    return {
      ok: false,
      reason: "Không thấy nút Save & Publish",
      finalUrl: page.url(),
      screenshotPath: sc ?? undefined,
    };
  }

  const isDisabled = await publishBtn
    .evaluate((el: HTMLElement) => el.classList.contains("is-disabled") || (el as HTMLButtonElement).disabled)
    .catch(() => false);
  if (isDisabled) {
    const sc = await captureScreenshot(page, "publish-disabled");
    return {
      ok: false,
      reason: "Nút Save & Publish đang disabled (form chưa hợp lệ)",
      finalUrl: page.url(),
      screenshotPath: sc ?? undefined,
    };
  }

  await publishBtn.scrollIntoViewIfNeeded();
  await publishBtn.click();
  console.log("🖱️ Đã click Save & Publish, đợi outcome...");

  const start = Date.now();
  const initialUrl = page.url();

  while (Date.now() - start < timeoutMs) {
    // Page bị đóng → fail
    if (page.isClosed()) {
      return { ok: false, reason: "Page bị đóng sau khi publish", finalUrl: "" };
    }

    // URL thay đổi rời khỏi create page → success
    const currentUrl = page.url();
    if (currentUrl !== initialUrl && !currentUrl.includes("/create.html")) {
      console.log(`✅ URL đã chuyển: ${currentUrl}`);
      return { ok: true, reason: `Redirect tới ${currentUrl}`, finalUrl: currentUrl };
    }

    // Error toast/notification/inline → fail ngay (đã click publish nên inline error có nghĩa)
    const errMsg = await checkPageErrors(page, true);
    if (errMsg) {
      await scrollFirstErrorIntoView(page);
      const sc = await captureScreenshot(page, "publish-error");
      return { ok: false, reason: errMsg, finalUrl: currentUrl, screenshotPath: sc ?? undefined };
    }

    // Success toast → đợi 10s URL change, nếu không cũng coi là success
    const successToast = page.locator(".el-message--success, .el-notification--success").first();
    if (await successToast.isVisible({ timeout: 200 }).catch(() => false)) {
      const txt = ((await successToast.textContent().catch(() => "")) ?? "").trim();
      console.log(`✅ Success toast: ${txt}`);
      try {
        await page.waitForFunction(
          () => !location.pathname.includes("/create.html"),
          { timeout: 10_000 }
        );
        return { ok: true, reason: `Success toast: ${txt}`, finalUrl: page.url() };
      } catch {
        return { ok: true, reason: `Success toast (no redirect): ${txt}`, finalUrl: page.url() };
      }
    }

    await page.waitForTimeout(500);
  }

  // Timeout: vẫn ở create page, không có toast → coi như fail
  const sc = await captureScreenshot(page, "publish-timeout");
  return {
    ok: false,
    reason: `Timeout ${timeoutMs / 1000}s, vẫn ở create page (không thấy toast)`,
    finalUrl: page.url(),
    screenshotPath: sc ?? undefined,
  };
};
