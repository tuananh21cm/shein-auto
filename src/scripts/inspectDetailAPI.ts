/**
 * Inspect 4Seller product detail page để tìm API load detail sản phẩm.
 *
 * Route mẫu: https://www.4seller.com/web/listing/tiktok/edit/<listingId>.html?status=active
 *
 * Usage:
 *   npx tsx src/scripts/inspectDetailAPI.ts --user=tuananh --id=801230460422
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
  const idArg = args.find((a) => a.startsWith("--id="));
  const username = userArg?.slice("--user=".length) || "tuananh";
  const listingId = idArg?.slice("--id=".length) || "801230460422";

  console.log(`▶️ Inspecting product detail API`);
  console.log(`   User: ${username}`);
  console.log(`   Listing ID: ${listingId}`);

  const cookie = await configCookie(username);
  console.log(`🍪 Loaded ${cookie.length} cookies\n`);

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
      resBodyPreview: body.slice(0, 5000),
    });

    const tag = `[${method}]`.padEnd(8);
    console.log(`${tag}${res.status()} ${url.replace("https://www.4seller.com", "")}`);
  });

  try {
    const url = `https://www.4seller.com/web/listing/tiktok/edit/${listingId}.html?status=active`;
    console.log(`📍 Open ${url}\n`);
    await page.goto(url, {
      timeout: 30000,
      waitUntil: "domcontentloaded",
    });
    console.log("\n📍 Wait 10s cho page load + lazy API");
    await page.waitForTimeout(10_000);
  } catch (err) {
    console.error("❌ Lỗi navigation:", err);
  }

  // Save trace
  const outDir = path.resolve(process.cwd(), "data", "network-trace");
  await fs.ensureDir(outDir);
  const outFile = path.join(outDir, `detail-${listingId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(outFile, JSON.stringify(captured, null, 2), "utf-8");
  console.log(`\n💾 Network trace saved: ${outFile}`);

  // Lọc endpoint detail (contain listing id hoặc "detail"/"get-listing")
  const detailLikely = captured.filter((r) => {
    const u = r.url.toLowerCase();
    const body = (r.reqBody || "").toLowerCase();
    return (
      u.includes(listingId.toLowerCase()) ||
      body.includes(listingId.toLowerCase()) ||
      /detail|get-listing|listing-info|listing\/get|tiktok\/get/.test(u)
    );
  });

  console.log("\n=== DETAIL-LIKELY ENDPOINTS ===");
  for (const r of detailLikely) {
    console.log(`\n[${r.method}] ${r.url.replace("https://www.4seller.com", "")}`);
    if (r.reqBody) console.log(`  REQ: ${r.reqBody.slice(0, 400)}`);
    if (r.resBodyPreview) console.log(`  RES: ${r.resBodyPreview.slice(0, 800)}`);
  }

  console.log("\n=== ALL UNIQUE ENDPOINTS ===");
  const seen = new Set<string>();
  for (const r of captured) {
    const key = `${r.method} ${new URL(r.url).pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${key}`);
  }

  console.log("\n⏳ Browser mở 30s — click thêm nếu muốn capture thêm");
  await page.waitForTimeout(30_000);
  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
