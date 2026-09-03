import { chromium, type Page } from "playwright-core";
import { solveImageCaptcha } from "../captcha/capsolver";
import { saveAccountCookie, setAccountEmail } from "../../state/fourSellerAccounts";
import { saveCred } from "../../state/fourSellerCreds";

/**
 * Tự đăng nhập 4Seller (email + password + giải captcha ảnh qua CapSolver) → lưu cookie
 * vào registry tài khoản (dùng chung saveAccountCookie). User chỉ cần username + password.
 * Cookie hết hạn → gọi lại hàm này (autoRefresh) với creds đã lưu.
 */
const LOGIN_URL = "https://www.4seller.com/en-US/login.html";

/** Grab ảnh captcha THẬT (visible, đủ to) — bỏ ảnh placeholder tí hon ẩn (w_18, width=0). */
async function grabVisibleCaptcha(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")]
      .filter((im: any) => (im.src || "").startsWith("data:image"))
      .map((im: any) => ({ src: im.src, w: im.getBoundingClientRect().width }))
      .filter((x) => x.w > 30)
      .sort((a, b) => b.w - a.w);
    return imgs[0]?.src || null;
  }).catch(() => null);
}

/** Tìm ô nhập verification code (xuất hiện sau khi bấm Sign In lần đầu). */
async function findCodeInput(page: Page) {
  const inFormItem = page.locator('.el-form-item:has(img[src^="data:image"]) input.el-input__inner');
  if (await inFormItem.count()) return inFormItem.first();
  const texts = page.locator("input.el-input__inner[type='text']");
  if ((await texts.count()) >= 2) return texts.nth(1);
  return texts.last();
}

const clickSignIn = (page: Page) => page.locator("button", { hasText: "Sign in" }).first().click().catch(() => {});

async function errorToast(page: Page): Promise<string | null> {
  const t = page.locator(".el-message--error, .el-message__content").first();
  if ((await t.count()) && (await t.isVisible().catch(() => false))) {
    return (await t.textContent().catch(() => ""))?.trim() || "lỗi không rõ";
  }
  return null;
}

export interface LoginResult { uid: string; label: string; shopCount: number; attempts: number; }

export async function loginAndSaveCookie(
  username: string,
  password: string,
  opts: { headless?: boolean; remember?: boolean; maxAttempts?: number } = {}
): Promise<LoginResult> {
  if (!username || !password) throw new Error("Thiếu username hoặc password");
  const headless = opts.headless ?? true;
  const maxAttempts = opts.maxAttempts ?? 4;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { timeout: 30000 });
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);

    const emailInput = page.locator("input.el-input__inner[type='text']").first();
    const passInput = page.locator("input.el-input__inner[type='password']").first();
    await emailInput.waitFor({ state: "visible", timeout: 15000 });
    await emailInput.fill(username);
    await passInput.fill(password);
    await page.waitForTimeout(500);

    // Bấm Sign In LẦN ĐẦU → 4Seller mới render ô Verification Code + ảnh captcha thật.
    await clickSignIn(page);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Chờ captcha THẬT (visible, đủ to) hiện — sau Sign In lần đầu, hoặc refresh sau lần sai.
      let src: string | null = null;
      for (let i = 0; i < 20 && !src; i++) { src = await grabVisibleCaptcha(page); if (!src) await page.waitForTimeout(500); }
      if (!src) throw new Error("Không thấy ảnh captcha sau khi bấm Sign In (selector/luồng đổi?)");

      const code = await solveImageCaptcha(src, { caseSensitive: false });
      console.log(`🔐 [login ${username}] captcha #${attempt} → "${code}"`);

      const codeInput = await findCodeInput(page);
      await codeInput.fill("");
      await codeInput.fill(code);
      await clickSignIn(page); // submit với code

      // Chờ điều hướng khỏi login HOẶC captcha đổi (sai) / toast lỗi.
      await Promise.race([
        page.waitForURL((u) => !/login\.html/i.test(u.toString()), { timeout: 8000 }).catch(() => {}),
        page.waitForTimeout(4500),
      ]);

      if (!/login\.html/i.test(page.url())) {
        await page.waitForTimeout(1500);
        const cookies = (await context.cookies()).filter((c) => (c.domain || "").includes("4seller.com"));
        const { account, shopSyncError } = await saveAccountCookie(cookies);
        await setAccountEmail(account.uid, username); // gán email (=username) làm nhãn dễ nhìn
        if (opts.remember) await saveCred({ username, password, uid: account.uid, label: account.label });
        console.log(`✅ [login ${username}] OK → ${account.label} (${account.shops.length} shop)${shopSyncError ? " ⚠️ " + shopSyncError : ""}`);
        return { uid: account.uid, label: account.label, shopCount: account.shops.length, attempts: attempt };
      }

      const toast = await errorToast(page);
      if (toast && /password|account|incorrect|not exist|wrong|密码|账号/i.test(toast)) {
        throw new Error(`Sai tài khoản/mật khẩu: ${toast}`);
      }
      console.warn(`⚠️ [login ${username}] captcha sai/chưa vào (attempt ${attempt})${toast ? " · " + toast : ""} → thử captcha mới`);
      // 4Seller thường tự đổi ảnh captcha sau lần sai; nếu không, click ảnh để refresh.
      await page.locator('img[src^="data:image"]').last().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    throw new Error(`Đăng nhập thất bại sau ${maxAttempts} lần (captcha đọc sai liên tục?)`);
  } finally {
    await browser.close();
  }
}
