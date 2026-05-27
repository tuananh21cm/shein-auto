/**
 * Test cookie 4Seller của 1 user.
 * Usage: npx tsx src/scripts/testCookie.ts --user=admin
 */
import "dotenv/config";
import { chromium } from "playwright-core";
import { configCookie } from "../utils/configCookie";

const main = async () => {
  const args = process.argv.slice(2);
  const userArg = args.find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length);
  if (!username) {
    console.error("Usage: npx tsx src/scripts/testCookie.ts --user=<username>");
    process.exit(1);
  }

  console.log(`▶️ Test cookie 4Seller cho user "${username}"...`);
  const cookie = await configCookie(username);
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
