/**
 * Debug: mở 1 sản phẩm SHEIN bằng Kiki, capture toàn bộ JSON network,
 * chạy scraper hiện tại, rồi báo cáo:
 *   - số màu / ảnh sản phẩm / ảnh từng variant (kiểm tra có ăn nhầm swatch)
 *   - các field "sold/sales/rating/review" tìm thấy trong network (để chấm điểm)
 *
 * Usage: npx tsx src/scripts/debugKikiProduct.ts --profile=<id> --url=<sheinUrl>
 *        (mặc định url = product-p-311110882)
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { scrapeSheinProduct } from "../services/kiki/sheinScraper";
import { ensureNoCaptcha } from "../services/kiki/captcha";
import { readKikiConfig } from "../services/kiki/config";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const main = async () => {
  const profileId = arg("profile") || readKikiConfig().profiles[0]?.id;
  const url = arg("url") || "https://us.shein.com/product-p-311110882.html";
  if (!profileId) throw new Error("Không có profileId (config/kiki.json rỗng) — truyền --profile=");

  console.log(`Profile: ${profileId}\nURL: ${url}\n`);
  await kiki.forceStop(profileId);
  const started = await kiki.startWithRetry(profileId, (m) => console.log("  " + m));
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const captured: { url: string; json: any }[] = [];
  let page: any;
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();

    const GOLDEN = /get_goods_detail_realtime_data|get_detail_rank_info|get_goods_detail_static_data|comment\/get|get_new_companion|detail\/recommend\/info/i;
    const golden: { url: string; json: any }[] = [];
    page.on("response", async (res: any) => {
      try {
        const u = res.url();
        if (!/shein/i.test(u)) return;
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;
        const j = await res.json().catch(() => null);
        if (!j) return;
        captured.push({ url: u, json: j });
        if (GOLDEN.test(u)) golden.push({ url: u, json: j });
      } catch {}
    });

    console.log("→ Mở trang…");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await ensureNoCaptcha(page, { onLog: (m) => console.log("  " + m), context: "DEBUG product", profileId });

    console.log("→ Chạy scraper…");
    const data = await scrapeSheinProduct(page, {});

    console.log("\n========== SCRAPER OUTPUT ==========");
    console.log("product_name:", (data.product_name || "").slice(0, 70));
    console.log("category:", data.category);
    console.log("COLORS (" + data.listing_variations.colors.length + "):", data.listing_variations.colors.join(", "));
    console.log("sizes:", data.listing_variations.sizes.join(", "));
    console.log("product_images:", data.product_images.length);
    data.product_images.forEach((u, i) => console.log(`   [${i}] ${u.slice(0, 90)}`));
    console.log("variant_images per color:");
    for (const vi of data.variant_images) {
      const [c, imgs] = Object.entries(vi)[0];
      console.log(`   ${c}: ${(imgs as string[]).length} ảnh`);
    }

    // Tìm field sold/sales/rating trong network
    console.log("\n========== NETWORK: tìm field đánh giá sp ==========");
    const RE = /sold|sale[s]?Volume|saleCount|sellCount|salesLabel|salesTip|comment_num|commentNum|comment_rank|rank_average|rating|review|wishlist|favorite|popular|hot/i;
    const found = new Map<string, any>();
    const scan = (o: any, depthPath: string, depth = 0) => {
      if (!o || typeof o !== "object" || depth > 6) return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (RE.test(k) && (typeof v === "string" || typeof v === "number")) {
          const key = k;
          if (!found.has(key)) found.set(key, v);
        }
        if (v && typeof v === "object") scan(v, depthPath + "." + k, depth + 1);
      }
    };
    for (const c of captured) scan(c.json, "");
    if (found.size === 0) console.log("(không thấy field nào khớp)");
    for (const [k, v] of found) console.log(`   ${k} = ${JSON.stringify(v).slice(0, 80)}`);

    // Soi các endpoint VÀNG (detail/realtime/rank/comment) cho sold/rating/rank
    console.log("\n========== GOLDEN ENDPOINTS ==========");
    const RE2 = /sold|sale[s]?Num|sale[s]?_?label|sale[s]?_?tip|comment_?num|commentNumShow|comment_?rank|rank_?average|rating|review_?num|reviewNum|rankInfo|rank_?info|salesVolume|trend|wishlist|favorite|addCart|hot/i;
    for (const gd of golden) {
      const short = gd.url.replace(/https?:\/\/[^/]+/, "").split("?")[0];
      const info = gd.json?.info ?? gd.json;
      const hits: string[] = [];
      const seen = new Set<string>();
      const scan = (o: any, p: string, depth: number) => {
        if (!o || typeof o !== "object" || depth > 7) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (RE2.test(k) && (typeof v === "string" || typeof v === "number") && v !== "" && v !== 0) {
            const key = k + JSON.stringify(v);
            if (!seen.has(key)) { seen.add(key); hits.push(`${k} = ${JSON.stringify(v).slice(0, 60)}`); }
          }
          if (v && typeof v === "object") scan(v, p, depth + 1);
        }
      };
      scan(info, "", 0);
      console.log(`\n▸ ${short}  (info keys: ${Object.keys(info || {}).slice(0, 12).join(",")})`);
      hits.slice(0, 25).forEach((h) => console.log(`    ${h}`));
      if (hits.length === 0) console.log(`    (không field số liệu)`);
    }

    // Lưu raw
    const outDir = path.resolve(process.cwd(), "data", "kiki-debug");
    await fs.ensureDir(outDir);
    const stamp = url.match(/-p-(\d+)/)?.[1] || "x";
    await fs.writeFile(path.join(outDir, `net-${stamp}.json`), JSON.stringify(captured.map((c) => ({ url: c.url, keys: Object.keys(c.json || {}) })), null, 2));
    for (let i = 0; i < golden.length; i++) {
      const name = golden[i].url.replace(/https?:\/\/[^/]+/, "").split("?")[0].replace(/[^a-z0-9]/gi, "_").slice(-50);
      await fs.writeFile(path.join(outDir, `golden-${i}-${name}.json`), JSON.stringify(golden[i].json, null, 2));
    }
    console.log(`\n💾 Lưu ${golden.length} golden responses + net list vào ${outDir}. Tổng ${captured.length} JSON.`);
  } finally {
    try { if (page) await page.close(); } catch {}
    try { await browser.close(); } catch {}
    await kiki.stopProfile(profileId);
  }
};

main().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
