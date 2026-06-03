/**
 * Inspect 4Seller TikTok listing page để tìm các API endpoint:
 *  - Load shop list
 *  - Switch shop (filter listings theo shop)
 *  - Listing list endpoint
 *  - Switch tab (Active / Inactive / Remove / Suspended)
 *
 * Mở browser (headless: false), tự navigate qua các trạng thái,
 * capture mọi POST/PUT/GET request đến /api/* của 4seller.com,
 * lưu thành JSON + print summary.
 *
 * Usage:
 *   npx tsx src/scripts/inspectListAPI.ts --user=tuananh
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { configCookie } from "../utils/configCookie";

interface CapturedRequest {
  ts: string;
  method: string;
  url: string;
  reqBody: string | null;
  resStatus: number;
  resContentType?: string;
  resBodyPreview: string;
}

const main = async () => {
  const args = process.argv.slice(2);
  const userArg = args.find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length) || "tuananh";

  console.log(`▶️ Inspecting 4Seller listing APIs với cookie user "${username}"`);

  const cookie = await configCookie(username);
  console.log(`🍪 Loaded ${cookie.length} cookies`);

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addCookies(cookie);
  const page = await ctx.newPage();

  page.on("dialog", (d) => d.accept());

  const captured: CapturedRequest[] = [];
  const inflight = new Map<any, { startedAt: number }>();

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("4seller.com/api/")) return;
    inflight.set(req, { startedAt: Date.now() });
  });

  page.on("response", async (res) => {
    const req = res.request();
    if (!inflight.has(req)) return;
    inflight.delete(req);

    const url = req.url();
    const method = req.method();
    const ct = res.headers()["content-type"] ?? "";
    let body = "";
    try {
      if (/json|text/i.test(ct)) body = await res.text();
    } catch {}

    captured.push({
      ts: new Date().toISOString(),
      method,
      url,
      reqBody: req.postData() ?? null,
      resStatus: res.status(),
      resContentType: ct,
      resBodyPreview: body.slice(0, 2000),
    });

    const tag = `[${method}]`.padEnd(8);
    console.log(`${tag}${res.status()} ${url.replace("https://www.4seller.com", "")}`);
  });

  try {
    console.log("\n📍 1. Open Active tab");
    await page.goto("https://www.4seller.com/web/listing/tiktok.html?type=tiktokActive", {
      timeout: 30000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(5000);

    console.log("\n📍 2. Click All Shop dropdown");
    // Tìm dropdown shop — thường ở góc trái trên, có text "All Shop"
    const shopDropdown = page
      .locator(
        "div.el-select, div[class*='shop'] .el-input__inner, button:has-text('All Shop'), [class*='shop-select']"
      )
      .first();
    try {
      await shopDropdown.click({ timeout: 5000 });
      console.log("✅ Clicked shop dropdown");
      await page.waitForTimeout(2000);
    } catch (e) {
      console.warn("⚠️ Không click được dropdown:", (e as Error).message);
    }

    console.log("\n📍 3. Pick first shop option");
    const firstOption = page
      .locator(".el-select-dropdown__item, .shop-option, [class*='shop-list'] li")
      .first();
    try {
      await firstOption.click({ timeout: 5000 });
      const optText = await firstOption.textContent({ timeout: 1000 }).catch(() => "?");
      console.log(`✅ Picked shop: ${optText?.trim()}`);
      await page.waitForTimeout(4000);
    } catch (e) {
      console.warn("⚠️ Không click option:", (e as Error).message);
    }

    console.log("\n📍 4. Switch sang tab Inactive");
    try {
      const inactiveTab = page.locator("text=/^Inactive/i").first();
      await inactiveTab.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch {
      console.warn("⚠️ Không switch sang Inactive");
    }

    console.log("\n📍 5. Switch sang tab Active");
    try {
      const activeTab = page.locator("text=/^Active/i").first();
      await activeTab.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch {
      console.warn("⚠️ Không switch sang Active");
    }

    console.log("\n📍 6. Wait 5s for any lazy requests");
    await page.waitForTimeout(5000);
  } catch (err) {
    console.error("❌ Lỗi navigation:", err);
  }

  // Save trace
  const outDir = path.resolve(process.cwd(), "data", "network-trace");
  await fs.ensureDir(outDir);
  const outFile = path.join(outDir, `listapi-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(outFile, JSON.stringify(captured, null, 2), "utf-8");
  console.log(`\n💾 Network trace saved: ${outFile}`);

  // Unique endpoints summary
  const unique = new Map<string, CapturedRequest[]>();
  for (const r of captured) {
    const pathname = new URL(r.url).pathname;
    const key = `${r.method} ${pathname}`;
    if (!unique.has(key)) unique.set(key, []);
    unique.get(key)!.push(r);
  }

  console.log("\n=== UNIQUE API ENDPOINTS ===");
  for (const [key, list] of unique.entries()) {
    const sample = list[0];
    console.log(`\n${key}  (called ${list.length}x)`);
    if (sample.reqBody) console.log(`  REQ: ${sample.reqBody.slice(0, 250)}`);
    if (sample.resBodyPreview) console.log(`  RES: ${sample.resBodyPreview.slice(0, 300)}`);
  }

  console.log(`\n💡 Detail trong file: ${outFile}`);
  console.log("⏳ Giữ browser mở 60s để bạn click thêm — capture sẽ tiếp tục...");
  await page.waitForTimeout(60_000);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
