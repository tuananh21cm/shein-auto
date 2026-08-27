/**
 * Đẩy DATA CŨ ở máy local lên Hub (chung qua LAN nếu đã set HUB_DIR).
 * Quét mọi *.json giống sản phẩm trong nguồn → dedup theo productId → ghi vào Hub đích
 * kèm _addedBy (ai cào). Mỗi thành viên chạy 1 lần với tên mình.
 *
 * Dùng (Windows PowerShell — BỎ dấu `--`, npm.ps1 nuốt nó):
 *   npm run hub:import-local --by=duyduc
 *   npm run hub:import-local --by=duc --from='C:/old hub,D:/backup'   (nháy đơn cả cụm nếu có dấu phẩy/cách)
 * Hoặc chạy thẳng bằng tsx (giữ `--`):
 *   npx tsx src/scripts/hubImportLocal.ts --by=tuananh
 * Mặc định nguồn = data/hub + BASE_SHEINAUTO_DIR. Đích = HUB_DIR (hub chung) — set trước khi chạy.
 */
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { config } from "../config";
import { cliArg } from "../utils/cliArgs";

const arg = cliArg;

const extractProductId = (data: any): string | null => {
  const url = typeof data?.url === "string" ? data.url : "";
  const m = url.match(/-p-(\d+)\.html/);
  if (m) return m[1];
  if (Array.isArray(data?.variant_ids)) {
    for (const v of data.variant_ids) {
      const id = Object.values(v || {})[0];
      if (id && /^\d+$/.test(String(id))) return String(id);
    }
  }
  return null;
};

const looksLikeProduct = (d: any) =>
  d && typeof d === "object" && !Array.isArray(d) &&
  (d.product_name || d.product_images || d.variant_images || d.listing_variations);

const isMeta = (f: string) => f.endsWith(".hubmeta.json") || f === "__hub_meta.json";

const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
  if (!(await fs.pathExists(dir))) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.toLowerCase().endsWith(".json") && !isMeta(e.name)) out.push(p);
  }
  return out;
};

const main = async () => {
  const by = (arg("by") || "").trim();
  if (!by) throw new Error("Thiếu --by=<tên bạn> (ghi ai cào). VD: --by=tuananh");

  const froms = (arg("from") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sources = froms.length
    ? froms
    : [path.resolve(process.cwd(), "data", "hub"), config.baseSheinAutoDir].filter(Boolean);

  console.log("👤 addedBy       :", by);
  console.log("📦 Hub đích       :", config.hubDir);
  console.log("📂 Nguồn quét    :", sources.join("  ·  "));
  if (!process.env.HUB_DIR) {
    console.warn("⚠️  HUB_DIR CHƯA set → đang đẩy vào hub LOCAL, KHÔNG phải hub chung. Set HUB_DIR (folder LAN) rồi chạy lại nếu muốn đẩy lên chung.\n");
  }

  await fs.ensureDir(config.hubDir);
  const existing = new Set<string>();
  for (const f of (await fs.readdir(config.hubDir)).filter((f) => f.endsWith(".json") && !isMeta(f))) {
    try { const id = extractProductId(await fs.readJson(path.join(config.hubDir, f))); if (id) existing.add(id); } catch { /* ignore */ }
  }

  let files: string[] = [];
  for (const s of sources) files = files.concat(await walk(s));
  console.log(`🔎 Tìm thấy ${files.length} file json trong nguồn. Đang đẩy...\n`);

  let imported = 0, dup = 0, invalid = 0, counter = 0;
  for (const f of files) {
    let d: any;
    try { d = await fs.readJson(f); } catch { invalid++; continue; }
    if (!looksLikeProduct(d)) { invalid++; continue; }
    const pid = extractProductId(d);
    if (pid && existing.has(pid)) { dup++; continue; }
    if (pid) existing.add(pid);
    const out = { ...d, _addedBy: d._addedBy || by, _addedAt: d._addedAt || Date.now() };
    const name = `hub_${Date.now()}_${counter++}_${Math.floor(Math.random() * 1e6)}.json`;
    await fs.writeFile(path.join(config.hubDir, name), JSON.stringify(out, null, 2), "utf-8");
    imported++;
    if (imported % 100 === 0) console.log(`   ...${imported} sp đã đẩy`);
  }
  console.log(`\n✅ Xong: ${imported} sp MỚI vào hub · ${dup} trùng (bỏ) · ${invalid} không phải sản phẩm`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
