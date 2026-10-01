/**
 * Nhập sản phẩm vào Hub (HUB_DIR) từ thư mục hoặc FILE ZIP do máy khác xuất (npm run hub:export).
 * Quét mọi *.json giống sản phẩm trong nguồn → dedup theo productId → ghi vào Hub đích
 * kèm _addedBy (ai cào). Sidecar .hubmeta.json (đã list shop nào) được GỘP theo productId
 * vào file local tương ứng (tên file mỗi máy khác nhau nên không gộp theo tên).
 *
 *   npm run hub:import-local --from=D:/nhan/hub-export-20261001.zip
 *   npm run hub:import-local --from='C:/old hub,D:/backup' --by=duc
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
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { config } from "../config";
import { cliArg } from "../utils/cliArgs";

const META = ".hubmeta.json";
interface HubMeta { shops: string[]; lastAt: number }
/** Gộp meta nguồn vào sidecar của file local: union shops, lastAt = max. Ghi atomic (tmp+rename) như listingScan. */
const mergeMeta = async (localFile: string, src: HubMeta): Promise<void> => {
  const p = path.join(config.hubDir, localFile + META);
  let cur: HubMeta = { shops: [], lastAt: 0 };
  try { cur = await fs.readJson(p); } catch { /* chưa có */ }
  const shops = [...new Set([...(cur.shops || []), ...(src.shops || [])])];
  const next: HubMeta = { shops, lastAt: Math.max(cur.lastAt || 0, src.lastAt || 0) };
  if (shops.length === (cur.shops || []).length && next.lastAt === (cur.lastAt || 0)) return; // không đổi
  const tmp = `${p}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf-8");
  await fs.move(tmp, p, { overwrite: true });
};
/** --from là .zip → giải nén ra temp (tar.exe có sẵn Windows, fallback Expand-Archive) rồi quét như thư mục. Dọn sau khi xong. */
const tmpDirs: string[] = [];
const unzipIfNeeded = async (src: string): Promise<string> => {
  if (!/.zip$/i.test(src)) return src;
  const dir = path.join(os.tmpdir(), `hub-import-${Date.now()}`);
  await fs.ensureDir(dir); tmpDirs.push(dir);
  const tar = path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe");
  if (await fs.pathExists(tar)) execFileSync(tar, ["-xf", path.resolve(src), "-C", dir], { stdio: "inherit" });
  else execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -Path '${path.resolve(src).replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], { stdio: "inherit" });
  return dir;
};

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

/** Khoá dedup: productId SHEIN; sp không có url/variant (hàng in-on-demand thêm tay) → băm tên+ảnh đầu, giống nhau ở mọi máy. */
const dedupKey = (d: any): string => {
  const pid = extractProductId(d);
  if (pid) return "p:" + pid;
  const raw = [d?.url, d?.product_name, (Array.isArray(d?.product_images) ? d.product_images[0] : "")].map((x) => String(x ?? "").trim().toLowerCase()).join("|");
  return "h:" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
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
    else if (e.name.toLowerCase().endsWith(".json") && !isMeta(e.name) && e.name !== "manifest.json") out.push(p);
  }
  return out;
};

const main = async () => {
  const by = (arg("by") || "").trim() || "import"; // file nguồn đã có _addedBy thì giữ của nguồn

  const froms = (arg("from") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sources: string[] = [];
  for (const s of froms.length ? froms : [path.resolve(process.cwd(), "data", "hub"), config.baseSheinAutoDir].filter(Boolean) as string[]) {
    sources.push(await unzipIfNeeded(s));
  }

  console.log("👤 addedBy       :", by);
  console.log("📦 Hub đích       :", config.hubDir);
  console.log("📂 Nguồn quét    :", sources.join("  ·  "));
  if (!process.env.HUB_DIR) {
    console.warn("⚠️  HUB_DIR CHƯA set → đang đẩy vào hub LOCAL, KHÔNG phải hub chung. Set HUB_DIR (folder LAN) rồi chạy lại nếu muốn đẩy lên chung.\n");
  }

  await fs.ensureDir(config.hubDir);
  const existing = new Map<string, string>(); // dedupKey → tên file local (để gộp meta vào đúng file)
  for (const f of (await fs.readdir(config.hubDir)).filter((f) => f.endsWith(".json") && !isMeta(f))) {
    try { existing.set(dedupKey(await fs.readJson(path.join(config.hubDir, f))), f); } catch { /* ignore */ }
  }

  let files: string[] = [];
  for (const s of sources) files = files.concat(await walk(s));
  console.log(`🔎 Tìm thấy ${files.length} file json trong nguồn. Đang đẩy...\n`);

  let imported = 0, dup = 0, invalid = 0, metaMerged = 0, counter = 0;
  for (const f of files) {
    let d: any;
    try { d = await fs.readJson(f); } catch { invalid++; continue; }
    if (!looksLikeProduct(d)) { invalid++; continue; }
    const key = dedupKey(d);
    let localName = existing.get(key);
    if (localName) { dup++; }
    else {
      const out = { ...d, _addedBy: d._addedBy || by, _addedAt: d._addedAt || Date.now() };
      localName = `hub_${Date.now()}_${counter++}_${Math.floor(Math.random() * 1e6)}.json`;
      await fs.writeFile(path.join(config.hubDir, localName), JSON.stringify(out, null, 2), "utf-8");
      existing.set(key, localName);
      imported++;
      if (imported % 100 === 0) console.log(`   ...${imported} sp đã đẩy`);
    }
    // Meta nguồn (đã list shop nào) → gộp vào sidecar của file local (mới hoặc trùng đều gộp).
    try {
      const m = await fs.readJson(f + META).catch(() => null);
      if (m && Array.isArray(m.shops) && m.shops.length) { await mergeMeta(localName, m); metaMerged++; }
    } catch { /* meta hỏng → bỏ */ }
  }
  console.log(`
✅ Xong: ${imported} sp MỚI vào hub · ${dup} trùng (bỏ) · ${metaMerged} meta đã gộp · ${invalid} không phải sản phẩm`);
  for (const d of tmpDirs) await fs.remove(d).catch(() => {});
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
