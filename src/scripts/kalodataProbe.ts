/**
 * P3.0 — Đào endpoint API Kalodata bằng Kiki (Kalodata bị Cloudflare → browser
 * thường bị chặn). Inject cookie config/kalodata.json vào phiên Kiki, mở các trang
 * (category, product), INTERCEPT mọi response JSON của kalodata.com → log endpoint
 * + dump sample vào data/kalodata-debug/ để thiết kế collector.
 *
 * Usage: npx tsx src/scripts/kalodataProbe.ts
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { readKikiConfig } from "../services/kiki/config";

const OUT_DIR = path.resolve(process.cwd(), "data", "kalodata-debug");

/** Cookie export (extension) → Playwright addCookies format. */
function toPlaywrightCookies(raw: any[]): any[] {
  const ss = (s: any): "Strict" | "Lax" | "None" => {
    const v = String(s || "").toLowerCase();
    if (v === "no_restriction" || v === "none") return "None";
    if (v === "strict") return "Strict";
    return "Lax";
  };
  const out: any[] = [];
  for (const c of raw) {
    if (!c?.name || c.value == null || !c.domain) continue;
    let sameSite = ss(c.sameSite);
    const secure = !!c.secure;
    if (sameSite === "None" && !secure) sameSite = "Lax"; // Playwright: None cần secure
    const ck: any = {
      name: c.name,
      value: String(c.value),
      domain: c.domain,
      path: c.path || "/",
      httpOnly: !!c.httpOnly,
      secure,
      sameSite,
    };
    if (typeof c.expirationDate === "number") ck.expires = Math.floor(c.expirationDate);
    out.push(ck);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.ensureDir(OUT_DIR);
  const cfg = readKikiConfig();
  const profileId = cfg.profiles[0]?.id;
  if (!profileId) throw new Error("Chưa có Kiki profile trong config/kiki.json");

  const rawCookies = (() => {
    const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config", "kalodata.json"), "utf8"));
    return Array.isArray(j) ? j : j.cookies || [];
  })();
  const cookies = toPlaywrightCookies(rawCookies);
  console.log(`🍪 ${cookies.length} cookie Kalodata sẽ inject.`);

  console.log(`Force-stop Kiki profile ${profileId}…`);
  await kiki.forceStop(profileId);
  const started = await kiki.startWithRetry(profileId, (m) => console.log("  ", m));
  console.log(`Kết nối CDP port ${started.debuggingPort}…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  // endpoint → { count, sampleSaved }
  const endpoints = new Map<string, { method: string; count: number; bytes: number }>();
  let sampleIdx = 0;

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    try {
      await ctx.addCookies(cookies);
      console.log("✅ Đã inject cookie vào context.");
    } catch (e: any) {
      console.warn("⚠️ addCookies lỗi (thử từng cái):", e?.message);
      for (const c of cookies) await ctx.addCookies([c]).catch(() => {});
    }

    const page = await ctx.newPage();

    page.on("response", async (res) => {
      try {
        const url = res.url();
        const u = new URL(url);
        if (!/kalodata\.com/i.test(u.host)) return;
        if (/\.(js|css|png|jpe?g|svg|woff2?|webp|ico|gif|map)(\?|$)/i.test(u.pathname)) return;
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;
        const body = await res.text().catch(() => "");
        if (!body || body.length < 50) return;
        const key = `${res.request().method()} ${u.host}${u.pathname}`;
        const prev = endpoints.get(key);
        endpoints.set(key, { method: res.request().method(), count: (prev?.count ?? 0) + 1, bytes: body.length });
        // Dump sample — ưu tiên endpoint dữ liệu chính (category/product/rank), kèm
        // REQUEST payload để biết cách gọi POST.
        const interesting = /categories|product|rank|overview|queryList/i.test(u.pathname);
        if ((interesting || sampleIdx < 40) && body.length > 200) {
          const safe = (u.pathname + u.search).replace(/[^a-z0-9]+/gi, "_").slice(0, 80);
          const reqBody = res.request().postData() || "";
          await fs.writeFile(
            path.join(OUT_DIR, `${String(sampleIdx).padStart(2, "0")}-${safe}.json`),
            `// ${res.request().method()} ${url}\n// REQUEST: ${reqBody.slice(0, 2000)}\n${body.slice(0, 200000)}`,
            "utf8"
          );
          sampleIdx++;
        }
      } catch {
        /* ignore */
      }
    });

    const visit = async (label: string, url: string) => {
      console.log(`\n▶ ${label}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => console.warn("goto:", e?.message));
      // Cloudflare?
      for (let i = 0; i < 12; i++) {
        const title = await page.title().catch(() => "");
        if (!/just a moment|attention required|checking your browser/i.test(title)) break;
        console.log(`   ⏳ Cloudflare "${title}" — chờ pass (${i + 1})…`);
        await sleep(2500);
      }
      await sleep(3000);
      // scroll để trigger lazy load + chuyển trang
      for (let s = 0; s < 4; s++) {
        await page.mouse.wheel(0, 1200).catch(() => {});
        await sleep(1200);
      }
      console.log(`   title="${await page.title().catch(() => "")}" url=${page.url()}`);
    };

    await visit("Category List", "https://www.kalodata.com/category");
    await visit("Product", "https://www.kalodata.com/product");
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
  }

  console.log(`\n=== ENDPOINT JSON KALODATA BẮT ĐƯỢC (${endpoints.size}) ===`);
  for (const [k, v] of [...endpoints.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  [${v.count}×, ${v.bytes}B] ${k}`);
  }
  console.log(`\n📁 Sample JSON đã dump vào: ${OUT_DIR} (${sampleIdx} file)`);
  if (endpoints.size === 0) {
    console.log("⚠️ 0 endpoint — có thể vẫn kẹt Cloudflare hoặc cookie hết hạn. Xem title log trên.");
  }
}

main().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
