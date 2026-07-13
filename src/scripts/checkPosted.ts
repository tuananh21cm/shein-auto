/**
 * Kiểm tra kênh TikTok của 1 Kiki profile xem có video nào vừa đăng không
 * (dùng để xác minh sau khi auto-post báo lỗi mơ hồ — TRÁNH đăng trùng).
 * Usage: npx tsx src/scripts/checkPosted.ts --profile=<kikiId>
 */
import "dotenv/config";
import path from "path";
import fs from "fs-extra";
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const profileId = arg("profile")!;
  await kiki.forceStop(profileId);
  const s = await kiki.startWithRetry(profileId, (m) => console.log("  " + m));
  const browser = await chromium.connectOverCDP(s.websocketDebuggerUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("dialog", (d) => d.accept().catch(() => {})); // bỏ qua dialog "exit?"

  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(8000);
    const text: string = await page.evaluate(() => document.body.innerText);
    console.log("=== NỘI DUNG TRANG POSTS (1200 ký tự đầu) ===");
    console.log(text.slice(0, 1200));

    const dir = path.resolve(process.cwd(), "data", "screenshots");
    await fs.ensureDir(dir);
    const f = path.join(dir, `posts-check-${Date.now()}.png`);
    await page.screenshot({ path: f, fullPage: false });
    console.log(`\n📸 ${f}`);
  } finally {
    await browser.close().catch(() => {});
    await kiki.forceStop(profileId).catch(() => {});
  }
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
