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
    // Element captcha phổ biến (GeeTest / SHEIN slider / iframe captcha)
    const count = await page
      .locator(
        [
          'iframe[src*="captcha" i]',
          ".geetest_holder",
          ".geetest_panel",
          ".geetest_box",
          '[class*="captcha" i][class*="slider" i]',
          '[class*="verify" i] [class*="slider" i]',
          '[id*="captcha" i]',
        ].join(", ")
      )
      .count()
      .catch(() => 0);
    return count > 0;
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
  const mode = opts.mode ?? "manual";

  if (mode === "capsolver" && opts.capsolverApiKey) {
    log("⚠️ Captcha — thử giải tự động qua CapSolver…");
    const solved = await trySolveWithCapsolver(page, opts).catch(() => false);
    if (solved) {
      log("✅ CapSolver giải xong.");
      return;
    }
    log("CapSolver không giải được — chuyển sang chờ giải thủ công.");
  }

  log(`⚠️ CAPTCHA xuất hiện — hãy GIẢI THỦ CÔNG trong cửa sổ Kiki (slider/click ảnh). Đang chờ tối đa ${Math.round(timeout / 1000)}s…`);
  // Báo Telegram để user biết mà vào giải
  notifyCaptcha({
    context: opts.context ?? "Cào SHEIN bằng Kiki",
    profileId: opts.profileId,
    url: (() => {
      try {
        return page.url();
      } catch {
        return undefined;
      }
    })(),
  }).catch(() => {});

  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(2500);
    if (!(await isCaptchaPresent(page))) {
      log("✅ Captcha đã được giải — tiếp tục.");
      // chờ trang ổn định lại sau khi qua captcha
      await page.waitForTimeout(2000);
      return;
    }
    if (Date.now() - lastLog > 20_000) {
      lastLog = Date.now();
      log(`Vẫn đang chờ giải captcha… (${Math.round((Date.now() - start) / 1000)}s)`);
    }
  }
  throw new Error("Hết thời gian chờ giải captcha (chưa giải xong).");
}

/**
 * (Stub) Giải captcha qua CapSolver. Chưa implement đầy đủ — cần biết loại
 * captcha cụ thể của SHEIN (GeeTest/slider) + sitekey. Trả false để fallback manual.
 */
async function trySolveWithCapsolver(_page: Page, _opts: CaptchaOptions): Promise<boolean> {
  // TODO: tích hợp CapSolver API (GeeTestTaskProxyLess / AntiTurnstile…) khi cần auto.
  return false;
}
