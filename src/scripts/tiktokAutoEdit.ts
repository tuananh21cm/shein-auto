/**
 * tiktokAutoEdit — TỰ ĐỘNG sửa listing TikTok Shop qua Kiki: vào từng listing Active, đợi nút
 * "suggestions" (title / search terms / attributes / product highlights) hiện ra, click + Apply,
 * rồi bấm Update (xanh lá). Lưu product_id đã edit (data/tiktok.db) để DEDUP (sp list liên tục).
 *
 * Usage:
 *   npx tsx src/scripts/tiktokAutoEdit.ts --discover            # DUMP DOM thật để chỉnh selector (chạy 1 lần khi Kiki bật)
 *   npx tsx src/scripts/tiktokAutoEdit.ts [N] --dry-run         # làm hết TRỪ Update (an toàn, test)
 *   npx tsx src/scripts/tiktokAutoEdit.ts [N]                   # thật: apply + Update + lưu id
 *   (N = số listing tối đa xử lý, mặc định 50; bỏ qua id đã edit)
 *
 * ⚠️ Cần: Kiki app bật + profile TikTok đã login TikTok Shop US. Thao tác THẬT trên shop.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { EditDb } from "../services/tiktok/editDb";

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "tiktok.json"), "utf8"));
const PROFILE = process.env.TIKTOK_PROFILE || cfg.profileId;
const MANAGE_URL = "https://seller-us.tiktok.com/product/manage?shop_region=US";
const SUGGEST_WAIT_MS = 40_000; // đợi nút suggestions hiện (~30s như yêu cầu, để dư 40s)

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tsx/esbuild (keepNames) chèn __name vào hàm con khi serialize page.evaluate → "__name is not defined".
// Shim sẵn trong trang trước khi evaluate có hàm con.
const injectShim = async (page: any) => {
  await page
    .evaluate(`(function(){ if (typeof window.__name === 'undefined') window.__name = function(f){return f;}; if (typeof window.__defProp === 'undefined') window.__defProp = Object.defineProperty; })()`)
    .catch(() => {});
};

const connect = async () => {
  log(`Force-stop + start Kiki profile ${PROFILE}…`);
  await kiki.forceStop(PROFILE);
  const started = await kiki.startWithRetry(PROFILE, (m) => log("  " + m));
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { browser, page };
};

/** Lấy danh sách product_id đang Active (cuộn để load hết virtual list). */
const getActiveProductIds = async (page: any): Promise<string[]> => {
  await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);
  // Tab Active (nếu có)
  try {
    const activeTab = page.locator('div,button,span').filter({ hasText: /^Active\s*\d*$/ }).first();
    if (await activeTab.count()) { await activeTab.click().catch(() => {}); await page.waitForTimeout(2500); }
  } catch { /* ignore */ }

  const ids = new Set<string>();
  for (let scroll = 0; scroll < 20; scroll++) {
    const texts: string[] = await page.locator("text=/ID[:：]\\s*\\d{8,}/").allInnerTexts().catch(() => []);
    for (const t of texts) { const m = t.match(/ID[:：]\s*(\d{8,})/); if (m) ids.add(m[1]); }
    const before = ids.size;
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(1200);
    // cũng thử lấy từ toàn page text (phòng selector trên miss)
    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    for (const m of body.matchAll(/ID[:：]\s*(\d{8,})/g)) ids.add(m[1]);
    if (ids.size === before && scroll > 3) break;
  }
  return [...ids];
};

/** Trang edit THẬT (sửa listing live): có nút "Update" + title sản phẩm. KHÁC form "Add product" rỗng
 *  (/product/create — có "Submit for review" + title "Add product"). */
const isRealEditPage = async (page: any): Promise<boolean> => {
  const update = await page.locator('button:has-text("Update")').count().catch(() => 0);
  const addProduct = await page.locator('text="Add product"').count().catch(() => 0);
  const submit = await page.locator('button:has-text("Submit for review")').count().catch(() => 0);
  return update > 0 && addProduct === 0 && submit === 0;
};

/** Tìm dòng product theo ID (cuộn để load), trả locator dòng đó hoặc null. */
const findRow = async (page: any, pid: string): Promise<any | null> => {
  let idNode = page.locator(`text=/ID[:：]\\s*${pid}\\b/`).first();
  for (let s = 0; s < 18 && !(await idNode.count().catch(() => 0)); s++) {
    await page.mouse.wheel(0, 1300); await page.waitForTimeout(900);
    idNode = page.locator(`text=/ID[:：]\\s*${pid}\\b/`).first();
  }
  if (!(await idNode.count().catch(() => 0))) return null;
  await idNode.scrollIntoViewIfNeeded().catch(() => {});
  return idNode.locator("xpath=ancestor::*[contains(@class,'core-table-row')][1]");
};

/** Phát hiện captcha TikTok (iframe/secsdk/verify) đang chặn. */
const hasCaptcha = async (page: any): Promise<boolean> => {
  try {
    if (/captcha|secsdk|verify-?bridge/i.test(page.url())) return true;
    return (await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [class*="secsdk" i], [id*="captcha" i]').count().catch(() => 0)) > 0;
  } catch { return false; }
};

/** Mở trang edit THẬT bằng cách CLICK nút Edit từ manage (mở tab mới ĐÚNG product). Chờ captcha trên
 *  manage nếu có. Verify URL tab edit CHỨA ĐÚNG pid (tránh load nhầm product cũ). */
const openEdit = async (page: any, pid: string): Promise<any | null> => {
  const ctx = page.context();
  if (!/product\/manage/i.test(page.url())) {
    await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  // CHỜ captcha (nếu có) được giải + list sản phẩm load xong.
  let warned = false;
  for (let p = 0; p < 60; p++) { // ~120s
    if (await hasCaptcha(page)) {
      if (!warned) { log(`  ⚠️ CAPTCHA trên trang sản phẩm — sếp giải trong cửa sổ Kiki, script đang CHỜ…`); warned = true; }
      await page.waitForTimeout(2000); continue;
    }
    if ((await page.locator("text=/ID[:：]\\s*\\d{8,}/").count().catch(() => 0)) > 0) break; // list đã load
    await page.waitForTimeout(2000);
  }

  const row = await findRow(page, pid);
  if (!row) { log(`  ⚠️ ko thấy dòng ${pid} trên manage`); return null; }
  const actionCell = row.locator(":scope > *").last(); // cột Action = cell con CUỐI
  const btns = actionCell.locator("button, a, [role='button'], svg"); // gồm cả svg (nút Edit có thể là svg trần)
  const cnt = Math.max(await btns.count().catch(() => 0), 1);
  for (let i = 0; i < Math.min(cnt, 8); i++) {
    await row.hover().catch(() => {});
    await page.waitForTimeout(500);
    const before = ctx.pages().length;
    const target = btns.nth(i);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(3000);
    let editPg = page;
    const pages = ctx.pages();
    if (pages.length > before) { editPg = pages[pages.length - 1]; await editPg.waitForLoadState("domcontentloaded").catch(() => {}); }
    log(`  click action#${i}: ${pages.length > before ? "TAB MỚI" : "cùng tab"} → ${editPg.url().replace(/^https:\/\/[^/]+/, "").slice(0, 55)}`);
    // VERIFY: trang edit thật + URL CHỨA ĐÚNG pid (poll ~12s, có thể có captcha trên tab edit).
    for (let p = 0; p < 8; p++) {
      if (await hasCaptcha(editPg)) { if (!warned) { log(`  ⚠️ CAPTCHA trên tab edit — sếp giải, đang CHỜ…`); warned = true; } await editPg.waitForTimeout(2000).catch(() => {}); continue; }
      if ((await isRealEditPage(editPg)) && editPg.url().includes(pid)) return editPg;
      await editPg.waitForTimeout(1500).catch(() => {});
    }
    if (editPg !== page) await editPg.close().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    if (!/product\/manage/i.test(page.url())) { await page.goBack().catch(() => {}); await page.waitForTimeout(2500); }
  }
  return null;
};

/** Trên trang edit: click HẾT 4 nút "suggestions" (SPAN.cursor-pointer) + Apply. Trả các phần đã apply. */
const applyAllSuggestions = async (page: any): Promise<string[]> => {
  const applied: string[] = [];
  // Trigger = SPAN.cursor-pointer có text "(N) suggestions" (KHÔNG phải SPAN.mr-2 nhãn).
  const triggerSel = () => page.locator("span.cursor-pointer").filter({ hasText: /^\s*(\d+\s*)?suggestions?\s*$/i });

  // Đợi nút suggestion đầu tiên xuất hiện (suggest hiện DẦN DẦN, đôi khi không hiện ngay/không hiện).
  const start = Date.now();
  while (Date.now() - start < SUGGEST_WAIT_MS) {
    if ((await triggerSel().count().catch(() => 0)) > 0) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);

  // KIÊN NHẪN time-based: cào tới khi ~18s KHÔNG có suggest mới (chờ section load dần). Mỗi nhãn thử ≤2 lần.
  const tried = new Map<string, number>();
  const DEADLINE = Date.now() + 100_000; // trần tổng 100s
  let lastSaw = Date.now();
  while (Date.now() < DEADLINE && Date.now() - lastSaw < 18_000) {
    const triggers = triggerSel();
    const cnt = await triggers.count().catch(() => 0);
    let clicked = false;
    for (let i = 0; i < cnt; i++) {
      const trig = triggers.nth(i);
      if (!(await trig.isVisible().catch(() => false))) continue;
      const label = ((await trig.innerText().catch(() => "")) || "").trim().slice(0, 18);
      if ((tried.get(label) || 0) >= 2) continue; // nhãn kẹt → bỏ qua
      tried.set(label, (tried.get(label) || 0) + 1);
      lastSaw = Date.now();
      await trig.scrollIntoViewIfNeeded().catch(() => {});
      await trig.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1300);
      // Apply của SUGGESTION = button "Apply"/"Apply all" KHÔNG trong .pulse-button-group (= nút Apply GIÁ).
      const applyBtns = page.locator(
        "xpath=//button[contains(@class,'core-btn')][normalize-space()='Apply' or normalize-space()='Apply all'][not(ancestor::*[contains(@class,'pulse-button-group')])]"
      );
      let ap = false;
      const an = await applyBtns.count().catch(() => 0);
      for (let k = 0; k < an; k++) {
        if (await applyBtns.nth(k).isVisible().catch(() => false)) {
          await applyBtns.nth(k).scrollIntoViewIfNeeded().catch(() => {});
          await applyBtns.nth(k).click({ timeout: 3000 }).catch(() => {});
          ap = true;
          break;
        }
      }
      if (ap) { await page.waitForTimeout(1600); applied.push(label || "suggest"); }
      else await page.keyboard.press("Escape").catch(() => {});
      clicked = true;
      break; // re-query từ đầu (DOM đổi sau apply)
    }
    if (!clicked) await page.waitForTimeout(2500); // ko có trigger mới → chờ load tiếp
  }
  return applied;
};

/** Bấm nút Update (xanh lá, góc phải). Trả về true nếu thành công (toast success / rời trang edit). */
const clickUpdate = async (page: any): Promise<boolean> => {
  const upd = page.locator('button.core-btn-primary:has-text("Update"), button:has-text("Update")').first();
  if (!(await upd.count().catch(() => 0))) return false;
  await upd.scrollIntoViewIfNeeded().catch(() => {});
  await upd.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3500);
  // DIAGNOSTIC: dump mọi message/toast đang hiện để biết text thật.
  const msgs = await page.locator('[class*="message" i], [class*="toast" i], [class*="notice" i], .core-message')
    .allInnerTexts().catch(() => [] as string[]);
  const msgText = [...new Set(msgs.map((m: string) => (m || "").replace(/\s+/g, " ").trim()).filter(Boolean))].join(" | ").slice(0, 120);
  const onList = /\/product\/manage/i.test(page.url());
  const okToast = /updated|success|saved|submitted|đã cập nhật|thành công|published/i.test(msgText);
  const errToast = /can.?not be empty|please|required|error|failed|invalid|không thể|thiếu/i.test(msgText);
  log(`    Update: onList=${onList} ok=${okToast} err=${errToast} msg="${msgText}"`);
  return onList || (okToast && !errToast);
};

// ---------- DISCOVER: dump DOM thật để chỉnh selector ----------
const runDiscover = async (page: any) => {
  log("🔎 DISCOVER — vào product/manage…");
  const ids = await getActiveProductIds(page);
  log(`Tìm thấy ${ids.length} product_id Active: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""}`);

  // Dump cấu trúc quanh sp đầu: leo cây tổ tiên + clickables + href edit.
  if (ids.length) {
    await injectShim(page);
    const dump = await page.evaluate((pid: string) => {
      let idEl: Element | null = null;
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (el.childElementCount === 0 && /ID[:：]/.test(el.textContent || "") && (el.textContent || "").includes(pid)) { idEl = el; break; }
      }
      if (!idEl) return { err: "ko thấy node chứa ID" };
      const desc = (c: Element) => ({ tag: c.tagName, cls: (c.className || "").toString().slice(0, 45), href: c.getAttribute("href") || "", aria: c.getAttribute("aria-label") || "", title: c.getAttribute("title") || "" });
      const chain: any[] = [];
      let node: Element | null = idEl;
      for (let up = 0; up < 7 && node; up++) {
        const clk = Array.from(node.querySelectorAll("a[href], button, [role='button'], svg, [class*='edit' i], [class*='action' i], [class*='pencil' i]")).slice(0, 10).map(desc);
        chain.push({ up, tag: node.tagName, cls: (node.className || "").toString().slice(0, 50), nClk: clk.length, clk });
        node = node.parentElement;
      }
      // mọi href trông như edit (chứa product id hoặc edit/create/update)
      const allHref = [...new Set(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || ""))];
      const links = allHref.filter((h) => h.includes(pid) || /edit|product\/(create|update|edit|manage_edit)/i.test(h)).slice(0, 8);
      // chain GỌN: chỉ tag+cls+số clickable mỗi cấp
      const chainSlim = chain.map((c) => `up${c.up}:${c.tag}.${c.cls}(${c.nClk}clk)`);
      return { chainSlim, editLinks: links, sampleHref: allHref.slice(0, 6) };
    }, ids[0]).catch((e: any) => ({ err: e?.message }));
    log("editLinks (URL edit): " + JSON.stringify((dump as any).editLinks || []));
    log("chain: " + JSON.stringify((dump as any).chainSlim || (dump as any).err || dump));
    log("sampleHref: " + JSON.stringify((dump as any).sampleHref || []));
  }

  // Dump cấu trúc các CELL của dòng sp[0] (tìm cột Action chứa nút Edit pencil).
  await injectShim(page);
  const actDump = await page.evaluate((pid: string) => {
    let idEl: Element | null = null;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (el.childElementCount === 0 && /ID[:：]/.test(el.textContent || "") && (el.textContent || "").includes(pid)) { idEl = el; break; }
    }
    if (!idEl) return { err: "ko thấy ID" };
    const row = idEl.closest("[class*='core-table-row'], tr");
    if (!row) return { err: "ko thấy row" };
    const cells = Array.from(row.children).map((cell, i) => ({
      cell: i,
      txt: ((cell as HTMLElement).innerText || "").replace(/\s+/g, " ").slice(0, 26),
      nClk: cell.querySelectorAll("svg, button, [role='button']").length,
    }));
    return { rowCls: (row.className || "").toString().slice(0, 40), nCells: cells.length, cells };
  }, ids[0]).catch((e: any) => ({ err: e?.message }));
  log("Row/cells sp[0]: " + JSON.stringify(actDump));

  // Mở edit sp[0] bằng CLICK nút Edit pencil → verify trang edit thật + capture URL + dump nút suggestions.
  log("Thử openEdit (click pencil) sp[0]…");
  const ep = await openEdit(page, ids[0]);
  if (ep) {
    log(`✅ VÀO TRANG EDIT THẬT! URL = ${ep.url()}`);
    await ep.waitForTimeout(SUGGEST_WAIT_MS / 2);
    await injectShim(ep);
    const dump = await ep.evaluate(() => {
      const hits: any[] = [];
      for (const el of Array.from(document.querySelectorAll("button, span, div"))) {
        const t = ((el as HTMLElement).innerText || "").trim();
        if (/^(\d+\s*)?suggestions?$|^Apply( all)?$|^Update$/i.test(t) && t.length < 25 && (el as HTMLElement).offsetParent !== null) {
          hits.push({ text: t, tag: el.tagName, cls: (el.className || "").toString().slice(0, 40) });
        }
      }
      return hits.slice(0, 30);
    }).catch((e: any) => ({ err: e?.message }));
    log("Nút trên trang edit thật: " + JSON.stringify(dump));

    // Click 1 suggest trigger → dump nút Apply XUẤT HIỆN SAU (phân biệt Apply suggestion vs Apply giá theo vị trí).
    const t1 = ep.locator("span.cursor-pointer").filter({ hasText: /^\s*(\d+\s*)?suggestions?\s*$/i }).first();
    if (await t1.count().catch(() => 0)) {
      await t1.scrollIntoViewIfNeeded().catch(() => {});
      const tb = await t1.boundingBox().catch(() => null);
      await t1.click({ timeout: 3000 }).catch(() => {});
      await ep.waitForTimeout(2000);
      await injectShim(ep);
      const applyDump = await ep.evaluate(() => {
        const hits: any[] = [];
        for (const el of Array.from(document.querySelectorAll("button, div, span, a"))) {
          const t = ((el as HTMLElement).innerText || "").trim();
          if (/^Apply( all)?$/i.test(t) && t.length < 12 && (el as HTMLElement).offsetParent !== null) {
            const r = el.getBoundingClientRect();
            hits.push({ text: t, tag: el.tagName, cls: (el.className || "").toString().slice(0, 45), top: Math.round(r.top), left: Math.round(r.left) });
          }
        }
        return hits.slice(0, 15);
      }).catch((e: any) => ({ err: e?.message }));
      log(`Trigger "suggestions" top=${tb ? Math.round(tb.y) : "?"}. Apply buttons SAU click: ` + JSON.stringify(applyDump));
    }
  } else {
    log("⚠️ openEdit chưa click đúng nút Edit — xem Row/cells ở trên để chỉnh.");
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const discover = argv.includes("--discover");
  const dryRun = argv.includes("--dry-run");
  const N = Number(argv.find((a) => /^\d+$/.test(a))) || 50;
  const pidArg = argv.find((a) => a.startsWith("--pid="))?.slice(6); // chỉ xử lý 1 product cụ thể
  const holdSec = Number(argv.find((a) => a.startsWith("--hold="))?.slice(7)) || 0; // giữ tab edit mở N giây để check
  if (!PROFILE) { console.log("❌ Chưa có profileId TikTok (config/tiktok.json)."); process.exit(1); }

  const { browser, page } = await connect();
  const edb = new EditDb();
  try {
    if (discover) { await runDiscover(page); return; }

    log(`▶️ Auto-edit TikTok listings (${pidArg ? "pid=" + pidArg : "tối đa " + N}, ${dryRun ? "DRY-RUN — KHÔNG Update" : "THẬT"}${holdSec ? `, giữ tab ${holdSec}s` : ""}). Đã edit trước: ${edb.count()}.`);
    let todo: string[];
    if (pidArg) {
      todo = [pidArg]; // chỉ định product cụ thể
    } else {
      const ids = await getActiveProductIds(page);
      log(`Active: ${ids.length} listing. Lọc bỏ id đã edit…`);
      todo = ids.filter((id) => !edb.isEdited(id)).slice(0, N);
    }
    log(`Sẽ xử lý ${todo.length} listing.`);

    let ok = 0, fail = 0;
    for (let i = 0; i < todo.length; i++) {
      const pid = todo[i];
      try {
        log(`[${i + 1}/${todo.length}] mở edit ${pid}…`);
        const editPage = await openEdit(page, pid);
        if (!editPage) { edb.mark(pid, { status: "failed", error: "ko mở được trang edit" }); fail++; log(`  ❌ ko mở được edit`); await page.goto(MANAGE_URL).catch(() => {}); continue; }
        const applied = await applyAllSuggestions(editPage);
        log(`  Đã apply: ${applied.length ? applied.join(", ") : "(không có suggestion)"}`);
        if (dryRun) {
          log(`  [dry-run] KHÔNG bấm Update.`);
          edb.mark(pid, { applied, status: "skipped" });
        } else {
          const updated = await clickUpdate(editPage);
          if (updated) { edb.mark(pid, { applied, status: "edited" }); ok++; log(`  ✅ Update OK`); }
          else { edb.mark(pid, { applied, status: "failed", error: "Update ko xác nhận" }); fail++; log(`  ⚠️ Update không chắc thành công`); }
        }
        // Giữ tab edit mở để sếp check (KHÔNG đóng, KHÔNG Update) — theo --hold.
        if (holdSec > 0) {
          log(`  ⏸️ Giữ tab edit mở ${holdSec}s để sếp check (URL: ${editPage.url().slice(0, 70)})…`);
          await editPage.waitForTimeout(holdSec * 1000).catch(() => {});
        }
        // Đóng tab edit nếu là tab mới; về lại manage.
        if (editPage !== page) await editPage.close().catch(() => {});
        await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(3000);
      } catch (e: any) {
        fail++; edb.mark(pid, { status: "failed", error: String(e?.message ?? e).slice(0, 120) });
        log(`  ❌ lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
        await page.goto(MANAGE_URL).catch(() => {});
      }
    }
    log(`🏁 XONG: ✅ ${ok} edit, ❌ ${fail} fail. Tổng đã edit (DB): ${edb.count()}.`);
  } finally {
    edb.close();
    await browser.close().catch(() => {});
    await kiki.stopProfile(PROFILE).catch(() => {});
  }
};

main().then(() => process.exit(0)).catch((e) => { log(`💥 ${e?.message ?? e}`); process.exit(1); });
