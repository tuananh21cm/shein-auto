/**
 * Inspect 4Seller network traffic trong khi listing.
 *
 * Chạy full flow listing như worker, NHƯNG:
 *  - Capture mọi POST/PUT/PATCH/DELETE request đến 4seller.com
 *  - Capture responses (status, content-type, body)
 *  - Lưu log vào data/network-trace/<timestamp>.json để analyze offline
 *  - Print summary ra terminal
 *
 * Usage:
 *   npx tsx src/scripts/inspectNetwork.ts <abs-path-to-json> --user=<username>
 *
 * Vd:
 *   npx tsx src/scripts/inspectNetwork.ts "C:/Users/KBT/Downloads/SheinAuto/P5-014/Fail/P5-014_434343.json" --user=tuananh
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { configCookie } from "../utils/configCookie";
import { listing4sellerShein } from "../core/listing4sellerShein";

interface CapturedRequest {
  ts: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  resStatus?: number;
  resHeaders?: Record<string, string>;
  resBody?: string;
  durationMs?: number;
}

const main = async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const userArg = args.find((a) => a.startsWith("--user="));
  const username = userArg?.slice("--user=".length);

  if (!file || !username) {
    console.error("Usage: npx tsx src/scripts/inspectNetwork.ts <abs-path-to-json> --user=<username>");
    process.exit(1);
  }

  const absFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!(await fs.pathExists(absFile))) {
    console.error(`File không tồn tại: ${absFile}`);
    process.exit(1);
  }

  console.log(`▶️ Inspecting network during listing flow...`);
  console.log(`   File: ${absFile}`);
  console.log(`   User: ${username}`);

  // Patch chromium.launch to inject network capture
  // Trick: monkey-patch chromium.launch returned browser to intercept page creation
  const originalLaunch = chromium.launch.bind(chromium);
  const captured: CapturedRequest[] = [];

  (chromium as any).launch = async (opts: any) => {
    const browser = await originalLaunch(opts);
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (ctxOpts: any) => {
      const ctx = await originalNewContext(ctxOpts);
      const originalNewPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const page = await originalNewPage();
        attachCapture(page, captured);
        return page;
      };
      return ctx;
    };
    return browser;
  };

  const t0 = Date.now();
  try {
    await listing4sellerShein(absFile, { cookieUser: username });
    console.log(`✅ Listing flow finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err: any) {
    console.error(`❌ Listing flow error: ${err?.message ?? err}`);
  }

  // Save trace
  const outDir = path.resolve(process.cwd(), "data", "network-trace");
  await fs.ensureDir(outDir);
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(outFile, JSON.stringify(captured, null, 2), "utf-8");
  console.log(`\n💾 Network trace saved: ${outFile}`);

  // Print summary
  console.log(`\n=== SUMMARY (${captured.length} requests) ===`);
  for (const r of captured) {
    const bodyPreview = r.reqBody ? r.reqBody.slice(0, 200).replace(/\n/g, " ") : "";
    const resPreview = r.resBody ? r.resBody.slice(0, 200).replace(/\n/g, " ") : "";
    console.log(`\n[${r.method}] ${r.url}`);
    console.log(`  → ${r.resStatus ?? "?"} (${r.durationMs ?? "?"}ms)`);
    if (bodyPreview) console.log(`  req:  ${bodyPreview}`);
    if (resPreview) console.log(`  res:  ${resPreview}`);
  }
};

function attachCapture(page: any, captured: CapturedRequest[]) {
  const inflight = new Map<any, { startedAt: number }>();

  page.on("request", (req: any) => {
    const url: string = req.url();
    const method: string = req.method();
    // Chỉ quan tâm 4Seller API (bỏ GET, asset)
    if (!url.includes("4seller.com")) return;
    if (method === "GET" || method === "OPTIONS") return;
    // Skip asset / preflight
    if (/\.(js|css|png|jpg|webp|svg|ico|woff|woff2)(\?|$)/i.test(url)) return;

    inflight.set(req, { startedAt: Date.now() });
  });

  page.on("response", async (res: any) => {
    const req = res.request();
    const meta = inflight.get(req);
    if (!meta) return;
    inflight.delete(req);

    const url = req.url();
    const method = req.method();
    let resBody = "";
    try {
      const ct = res.headers()["content-type"] ?? "";
      // Chỉ capture body nếu là JSON / text (tránh binary)
      if (/json|text|xml|x-www-form/i.test(ct)) {
        resBody = await res.text();
      }
    } catch {
      // ignore
    }

    captured.push({
      ts: new Date().toISOString(),
      method,
      url,
      reqHeaders: req.headers(),
      reqBody: req.postData() ?? null,
      resStatus: res.status(),
      resHeaders: res.headers(),
      resBody: resBody.slice(0, 50_000), // cap 50KB/response
      durationMs: Date.now() - meta.startedAt,
    });

    // Live log
    const tag = `[${method}]`.padEnd(8);
    console.log(`${tag}${res.status()} ${url}`);
  });
}

main();
