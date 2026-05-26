/**
 * Test cookie 4Seller: mở Chromium, navigate đến create page, in URL cuối.
 */
import "dotenv/config";
import { chromium } from "playwright-core";
import { configCookie } from "../utils/configCookie";

const main = async () => {
  console.log("▶️ Test cookie 4Seller...");
  const cookie = await configCookie();
  console.log(`🍪 Loaded ${cookie.length} cookies`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies(cookie);
  const page = await ctx.newPage();

  try {
    const resp = await page.goto(
      "https://www.4seller.com/web/listing/tiktok/create.html?status=draft",
      { timeout: 25000, waitUntil: "domcontentloaded" }
    );
    await page.waitForTimeout(3000);
    const finalUrl = page.url();
    const status = resp?.status() ?? "—";
    const isLogin = finalUrl.includes("/login") || finalUrl.includes("/sign-in");
    console.log(`📍 Final URL: ${finalUrl}`);
    console.log(`📍 HTTP status: ${status}`);
    console.log(`📍 Verdict: ${isLogin ? "❌ Cookie INVALID (bị về login)" : "✅ Cookie OK"}`);
  } catch (err: any) {
    console.error("❌ Lỗi:", err?.message ?? err);
    process.exit(2);
  } finally {
    await browser.close();
  }
};

main();
