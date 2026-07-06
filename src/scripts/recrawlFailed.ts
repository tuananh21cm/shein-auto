/**
 * recrawlFailed — CÀO LẠI các sp bị fail listing (JSON nằm trong <shop>/Fail/).
 *
 * Fail thường do JSON cào HỎNG (product_name rỗng, thiếu ảnh/màu). Nay autoCrawler đã có
 * HARD GATE chặn JSON hỏng từ đầu (hardScrapeError), nhưng file fail CŨ vẫn còn → script này
 * đưa chúng về hàng đợi cào lại: reset shop_allocation (goods_id, shop) → 'recrawl',
 * crawl_attempts=0, và chuyển file Fail → Fail/recrawled/ (giữ để audit) + xoá .error.log.
 *
 * Usage:
 *   npx tsx src/scripts/recrawlFailed.ts                 → DRY-RUN mọi shop (chỉ liệt kê)
 *   npx tsx src/scripts/recrawlFailed.ts "<shop>"        → DRY-RUN 1 shop (khớp 1 phần)
 *   npx tsx src/scripts/recrawlFailed.ts "<shop>" apply  → THỰC THI (reset + move file)
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { getDb } from "../state/db";
import { getShopOwner, getUserDirsByName } from "../state/userDirs";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv[argv.length - 1] === "apply";
  if (apply) argv.pop();
  const shopArg = argv.join(" ").trim();

  const db = getDb();
  // Shop có allocation (nguồn để resolve baseDir + reset trạng thái).
  let shops = (db.prepare("SELECT DISTINCT shop FROM shop_allocation").all() as any[]).map((r) => r.shop as string);
  if (shopArg) shops = shops.filter((s) => s.toLowerCase().includes(shopArg.toLowerCase()));
  if (!shops.length) return out({ ok: false, error: `Không có shop khớp "${shopArg}".` });

  const reset = db.prepare("UPDATE shop_allocation SET status='recrawl', crawl_attempts=0 WHERE goods_id=? AND shop=?");
  const report: any[] = [];
  let totalReset = 0;

  for (const shop of shops) {
    const owner = await getShopOwner(shop);
    const dirs = owner ? await getUserDirsByName(owner) : null;
    const baseDir = dirs?.baseSheinAutoDir;
    if (!baseDir) { report.push({ shop, skipped: "thiếu baseSheinAutoDir" }); continue; }

    const failDir = path.join(baseDir, shop, "Fail");
    if (!(await fs.pathExists(failDir))) continue;
    const files = (await fs.readdir(failDir)).filter((f) => f.endsWith(".json"));
    if (!files.length) continue;

    const doneDir = path.join(failDir, "recrawled");
    let resetN = 0, noGid = 0;
    const gids: string[] = [];
    for (const f of files) {
      const full = path.join(failDir, f);
      let gid = "";
      try {
        const j = JSON.parse(await fs.readFile(full, "utf-8"));
        gid = String(j.goods_id || j.url?.match(/-p-(\d+)\.html/)?.[1] || "");
      } catch { /* JSON hỏng → không đọc được gid */ }
      if (!/^\d{5,}$/.test(gid)) { noGid++; continue; }
      gids.push(gid);
      if (apply) {
        reset.run(gid, shop);
        await fs.ensureDir(doneDir);
        await fs.move(full, path.join(doneDir, f), { overwrite: true }).catch(() => {});
        await fs.remove(full + ".error.log").catch(() => {});
      }
      resetN++;
    }
    totalReset += resetN;
    report.push({ shop, failFiles: files.length, willRecrawl: resetN, noGoodsId: noGid, sample: gids.slice(0, 5) });
  }

  out({ ok: true, apply, shopsScanned: shops.length, totalRecrawl: totalReset, note: apply ? "đã reset + move file, autoCrawler sẽ cào lại" : "DRY-RUN — thêm 'apply' để thực thi", report });
}

main().catch((e) => { out({ ok: false, error: String(e?.message ?? e) }); process.exitCode = 1; });
