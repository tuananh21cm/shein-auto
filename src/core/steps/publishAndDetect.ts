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
        if (trimmed) return `${sel}: ${trimmed}`;
      }
    } catch {
      // tiếp tục
    }
  }
  return null;
};

/**
 * Quét các "blocker" validation mà checkPageErrors bỏ sót:
 *  - el-message-box modal (confirm/alert chặn submit)
 *  - text validation rải rác trong bảng variant ("Can not be empty", "required"...)
 *    — không dùng class .el-form-item__error nên checkPageErrors không thấy.
 * Trả về chuỗi mô tả (kèm field gần nhất nếu có) hoặc null.
 */
export const collectBlockers = async (page: any): Promise<string | null> => {
  try {
    return await page.evaluate(() => {
      const out: string[] = [];

      // 1. Modal el-message-box (nếu có) — thường chặn toàn bộ submit
      const mb = document.querySelector(".el-message-box");
      if (mb && (mb as HTMLElement).offsetParent !== null) {
        const t = (mb.textContent || "").replace(/\s+/g, " ").trim();
        if (t) out.push(`[modal] ${t.slice(0, 200)}`);
      }

      // 2. Text validation ở các leaf node đang hiển thị.
      // Cố ý KHÔNG match chữ "required" trơ — nó hay xuất hiện ở label/help/header
      // (vd cột bắt buộc) gây false positive. Chỉ match cụm lỗi rõ ràng.
      const re =
        /can ?not be empty|cannot be empty|this field is required|is required|please (enter|select|complete|upload|fill|add)/i;
      const all = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
      for (const el of all) {
        if (el.children.length > 0) continue; // chỉ leaf
        if (el.offsetParent === null) continue; // phải đang hiển thị
        const txt = (el.textContent || "").trim();
        if (!txt || txt.length > 80 || !re.test(txt)) continue;

        let ctx = "";

        // (a) Nếu lỗi nằm trong bảng variant → lấy tên variant của row + header cột
        const tr = el.closest("tr");
        if (tr) {
          let variant = "";
          const titled = tr.querySelector("div.line_ellipsis[title]");
          if (titled) variant = (titled.getAttribute("title") || "").trim();
          if (!variant) {
            for (const td of Array.from(tr.querySelectorAll("td"))) {
              const t = (td.textContent || "").trim();
              if (t) { variant = t; break; }
            }
          }
          let col = "";
          const td = el.closest("td");
          if (td) {
            const idx = Array.from(tr.children).indexOf(td);
            const table = tr.closest("table");
            const head = table ? Array.from(table.querySelectorAll("thead th, thead td")) : [];
            if (idx >= 0 && head[idx]) col = (head[idx].textContent || "").replace(/\s+/g, " ").trim();
          }
          ctx = [variant && `variant "${variant}"`, col && `cột "${col}"`].filter(Boolean).join(", ");
        }

        // (b) fallback: title/aria-label của ancestor
        if (!ctx) {
          let p: HTMLElement | null = el;
          for (let k = 0; k < 6 && p; k++) {
            p = p.parentElement;
            const cand = p?.getAttribute?.("title") || p?.getAttribute?.("aria-label");
            if (cand) { ctx = `gần "${cand}"`; break; }
          }
        }

        out.push(ctx ? `${txt} (${ctx})` : txt);
        if (out.length >= 8) break;
      }

      return Array.from(new Set(out)).join(" | ") || null;
    });
  } catch {
    return null;
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
  opts?: { dryRun?: boolean; timeoutMs?: number }
): Promise<PublishOutcome> => {
  const timeoutMs = opts?.timeoutMs ?? 90_000;

  if (opts?.dryRun) {
    return {
      ok: true,
      reason: "dryRun=true, không click Save & Publish",
      finalUrl: page.url(),
    };
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

    // Success toast → ưu tiên cao nhất (4Seller bắn "Successfully!" khi publish OK)
    const successToastEarly = page
      .locator(".el-message--success, .el-notification--success")
      .first();
    if (await successToastEarly.isVisible({ timeout: 200 }).catch(() => false)) {
      const txt = ((await successToastEarly.textContent().catch(() => "")) ?? "").trim();
      console.log(`✅ Success toast: ${txt}`);
      try {
        await page.waitForFunction(() => !location.pathname.includes("/create.html"), {
          timeout: 10_000,
        });
        return { ok: true, reason: `Success toast: ${txt}`, finalUrl: page.url() };
      } catch {
        return { ok: true, reason: `Success toast (no redirect): ${txt}`, finalUrl: page.url() };
      }
    }

    // Error toast/notification/inline → fail ngay (đã click publish nên inline error có nghĩa)
    const errMsg = await checkPageErrors(page, true);
    if (errMsg) {
      const sc = await captureScreenshot(page, "publish-error");
      return { ok: false, reason: errMsg, finalUrl: currentUrl, screenshotPath: sc ?? undefined };
    }

    await page.waitForTimeout(500);
  }

  // Timeout: vẫn ở create page, không có toast → coi như fail
  const blocker = await collectBlockers(page);
  const sc = await captureScreenshot(page, "publish-timeout");
  return {
    ok: false,
    reason:
      `Timeout ${timeoutMs / 1000}s, vẫn ở create page (không thấy toast)` +
      (blocker ? ` — nghi do: ${blocker}` : ""),
    finalUrl: page.url(),
    screenshotPath: sc ?? undefined,
  };
};
