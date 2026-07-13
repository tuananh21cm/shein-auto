/**
 * Dump DOM thật của trang upload TikTok Studio (sau khi upload xong) để biết
 * khối "Add link" có tồn tại không và selector đúng là gì.
 * Usage: npx tsx src/scripts/discoverAddLink.ts --profile=<kikiId> --id=<videoId>
 */
import "dotenv/config";
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { VideoDb } from "../state/videoDb";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const profileId = arg("profile")!;
  const id = parseInt(arg("id") ?? "1");
  const db = new VideoDb();
  const row = db.get(id)!;
  db.close();

  await kiki.forceStop(profileId);
  const s = await kiki.startWithRetry(profileId, (m) => console.log("  " + m));
  const browser = await chromium.connectOverCDP(s.websocketDebuggerUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/upload?from=creator_center", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(4000);
    await page.locator('input[type="file"]').first().setInputFiles(row.file!);
    console.log("⏳ Chờ upload…");
    await page.locator("text=/Uploaded/i").first().waitFor({ state: "visible", timeout: 240_000 });
    console.log("✓ Uploaded\n");
    await sleep(3000);

    // Ai đang login?
    const who = await page.evaluate(() => {
      const t = document.body.innerText;
      return t.slice(0, 0) || "";
    });

    console.log("=== CÓ TEXT 'Add link' TRÊN TRANG? ===");
    const bodyText: string = await page.evaluate(() => document.body.innerText);
    console.log(`  "Add link": ${/add link/i.test(bodyText) ? "CÓ" : "KHÔNG"}`);
    console.log(`  "Products": ${/products/i.test(bodyText) ? "CÓ" : "KHÔNG"}`);

    console.log("\n=== CÁC SECTION LABEL trên trang (theo thứ tự) ===");
    const labels: string[] = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("div,span,label,h1,h2,h3,h4").forEach((el) => {
        const kids = (el as HTMLElement).children.length;
        const txt = ((el as HTMLElement).innerText || "").trim();
        if (kids === 0 && txt && txt.length < 40) out.push(txt);
      });
      return [...new Set(out)];
    });
    console.log(labels.join(" | "));

    console.log("\n=== TẤT CẢ BUTTON (text + class) ===");
    const btns: any[] = await page.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll('button, [role="button"], div[class*="btn" i]').forEach((el) => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        const txt = (e.innerText || "").trim().slice(0, 40);
        if (txt) out.push({ txt, tag: e.tagName, cls: (e.className || "").toString().slice(0, 60), visible: r.width > 0 && r.height > 0 });
      });
      return out;
    });
    for (const b of btns) console.log(`  [${b.tag}] "${b.txt}" visible=${b.visible} cls=${b.cls}`);

    console.log("\n👀 Browser mở 90s — cuộn xem tận mắt có khối 'Add link' không.");
    await sleep(90_000);
  } finally {
    await browser.close().catch(() => {});
    await kiki.forceStop(profileId).catch(() => {});
  }
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
