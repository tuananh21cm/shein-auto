/**
 * Trao đổi Hub giữa các máy (mỗi máy HUB_DIR khác nhau): xuất zip / nhập zip-thư mục.
 * Dùng chung cho CLI (scripts/hubExport.ts, scripts/hubImportLocal.ts) và Admin UI (màn Hub).
 *
 * Zip = file sp hub_*.json + sidecar <file>.hubmeta.json (đã list shop nào) + manifest.json.
 * Nhập: dedup theo productId (sp không url/variant → băm tên+ảnh), ghi file tên mới,
 * GỘP meta theo productId vào file local (tên file mỗi máy khác nhau nên không gộp theo tên).
 *
 * ponytail: nén bằng tar.exe có sẵn Windows (bsdtar; -T đọc tên bị lỗi nên hard link vào tmp rồi nén cả thư mục).
 * Không có tar → Compress-Archive (chậm ~3 phút/4500 file).
 */
import fs from "fs-extra";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { config } from "../config";

const META = ".hubmeta.json";
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
export const isHubMeta = (f: string) => f.endsWith(META) || f === "__hub_meta.json";
interface HubMeta { shops: string[]; lastAt: number }

/* ───────────── khoá dedup ───────────── */
export const extractProductId = (data: any): string | null => {
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
/** productId SHEIN; sp không có url/variant (hàng in-on-demand thêm tay) → băm tên+ảnh đầu, giống nhau ở mọi máy. */
export const dedupKey = (d: any): string => {
  const pid = extractProductId(d);
  if (pid) return "p:" + pid;
  const raw = [d?.url, d?.product_name, Array.isArray(d?.product_images) ? d.product_images[0] : ""]
    .map((x) => String(x ?? "").trim().toLowerCase()).join("|");
  return "h:" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
};
export const looksLikeProduct = (d: any) =>
  d && typeof d === "object" && !Array.isArray(d) &&
  (d.product_name || d.product_images || d.variant_images || d.listing_variations);

/* ───────────── EXPORT ───────────── */
export interface ExportResult { out: string; total: number; products: number; metas: number; bytes: number }

const stageFiles = async (hub: string, names: string[], stage: string): Promise<void> => {
  for (const n of names) {
    const src = path.join(hub, n), dst = path.join(stage, n);
    try { await fs.link(src, dst); } catch { await fs.copy(src, dst); } // khác ổ đĩa → copy
  }
};
const zipDir = (stage: string, out: string): void => {
  if (fs.existsSync(TAR)) { execFileSync(TAR, ["-a", "-cf", out, "-C", stage, "."], { stdio: "pipe" }); return; }
  const q = (x: string) => x.replace(/'/g, "''");
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${q(stage)}\\*' -DestinationPath '${q(out)}' -Force`], { stdio: "pipe" });
};

/** Xuất Hub ra zip. sinceMs > 0 → chỉ sp mtime mới HOẶC meta mới (vừa list sang shop). Trả products=0 nếu không có gì. */
export async function exportHub(opts: { out: string; sinceMs?: number }): Promise<ExportResult> {
  const hub = config.hubDir;
  const sinceMs = opts.sinceMs ?? 0;
  if (!(await fs.pathExists(hub))) throw new Error(`HUB_DIR không tồn tại: ${hub}`);
  const names = (await fs.readdir(hub)).filter((f) => f.endsWith(".json") && !isHubMeta(f));
  const pick: string[] = [];
  let products = 0, metas = 0;
  for (const f of names) {
    const st = await fs.stat(path.join(hub, f));
    const mst = await fs.stat(path.join(hub, f + META)).catch(() => null);
    const fresh = !sinceMs || st.mtimeMs >= sinceMs || (mst?.mtimeMs ?? 0) >= sinceMs;
    if (!fresh) continue;
    pick.push(f); products++;
    if (mst) { pick.push(f + META); metas++; }
  }
  if (!products) return { out: opts.out, total: names.length, products: 0, metas: 0, bytes: 0 };

  const stage = path.join(os.tmpdir(), `hub-export-${Date.now()}`);
  await fs.ensureDir(stage);
  try {
    await stageFiles(hub, pick, stage);
    await fs.writeJson(path.join(stage, "manifest.json"), {
      exportedAt: new Date().toISOString(), host: os.hostname(), hubDir: hub, sinceMs, products, metas,
    }, { spaces: 2 });
    await fs.ensureDir(path.dirname(opts.out));
    await fs.remove(opts.out);
    zipDir(stage, opts.out);
  } finally {
    await fs.remove(stage).catch(() => {});
  }
  return { out: opts.out, total: names.length, products, metas, bytes: (await fs.stat(opts.out)).size };
}

/* ───────────── IMPORT ───────────── */
export interface ImportResult { found: number; imported: number; dup: number; metaMerged: number; invalid: number }

/** Gộp meta nguồn vào sidecar của file local: union shops, lastAt = max. Ghi atomic (tmp+rename) như listingScan. */
const mergeMeta = async (localFile: string, src: HubMeta): Promise<void> => {
  const p = path.join(config.hubDir, localFile + META);
  let cur: HubMeta = { shops: [], lastAt: 0 };
  try { cur = await fs.readJson(p); } catch { /* chưa có */ }
  const shops = [...new Set([...(cur.shops || []), ...(src.shops || [])])];
  const next: HubMeta = { shops, lastAt: Math.max(cur.lastAt || 0, src.lastAt || 0) };
  if (shops.length === (cur.shops || []).length && next.lastAt === (cur.lastAt || 0)) return;
  const tmp = `${p}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf-8");
  await fs.move(tmp, p, { overwrite: true });
};

const unzipToTmp = async (zip: string): Promise<string> => {
  const dir = path.join(os.tmpdir(), `hub-import-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.ensureDir(dir);
  if (await fs.pathExists(TAR)) execFileSync(TAR, ["-xf", path.resolve(zip), "-C", dir], { stdio: "pipe" });
  else execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -Path '${path.resolve(zip).replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], { stdio: "pipe" });
  return dir;
};

const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
  if (!(await fs.pathExists(dir))) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.toLowerCase().endsWith(".json") && !isHubMeta(e.name) && e.name !== "manifest.json") out.push(p);
  }
  return out;
};

/** Nhập từ zip và/hoặc thư mục vào HUB_DIR. by = ghi _addedBy cho sp chưa có. */
export async function importHub(opts: { sources: string[]; by?: string; log?: (m: string) => void }): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const by = (opts.by || "").trim() || "import";
  const tmpDirs: string[] = [];
  try {
    const dirs: string[] = [];
    for (const s of opts.sources) {
      if (/\.zip$/i.test(s)) { const d = await unzipToTmp(s); tmpDirs.push(d); dirs.push(d); }
      else dirs.push(s);
    }
    await fs.ensureDir(config.hubDir);
    const existing = new Map<string, string>(); // dedupKey → tên file local
    for (const f of (await fs.readdir(config.hubDir)).filter((f) => f.endsWith(".json") && !isHubMeta(f))) {
      try { existing.set(dedupKey(await fs.readJson(path.join(config.hubDir, f))), f); } catch { /* ignore */ }
    }
    // Mỗi nguồn zip kèm manifest.json {host, exportedAt} → sp mới ghi _importedFrom = tên máy xuất.
    const batches: { files: string[]; from: string | null }[] = [];
    for (const d of dirs) {
      const mf = await fs.readJson(path.join(d, "manifest.json")).catch(() => null);
      batches.push({ files: await walk(d), from: mf?.host ? String(mf.host) : null });
    }
    const found = batches.reduce((n, b) => n + b.files.length, 0);
    log(`🔎 Tìm thấy ${found} file json trong nguồn.`);

    const r: ImportResult = { found, imported: 0, dup: 0, metaMerged: 0, invalid: 0 };
    const importedAt = Date.now();
    let counter = 0;
    for (const b of batches) for (const f of b.files) {
      let d: any;
      try { d = await fs.readJson(f); } catch { r.invalid++; continue; }
      if (!looksLikeProduct(d)) { r.invalid++; continue; }
      const key = dedupKey(d);
      let localName = existing.get(key);
      if (localName) r.dup++;
      else {
        // _addedBy = người cào gốc (giữ nguyên); _importedBy/_importedFrom/_importedAt = ai nhập, từ máy nào, lúc nào.
        const out = { ...d, _addedBy: d._addedBy || by, _addedAt: d._addedAt || Date.now(),
          _importedBy: by, _importedAt: importedAt, ...(b.from ? { _importedFrom: b.from } : {}) };
        localName = `hub_${Date.now()}_${counter++}_${Math.floor(Math.random() * 1e6)}.json`;
        await fs.writeFile(path.join(config.hubDir, localName), JSON.stringify(out, null, 2), "utf-8");
        existing.set(key, localName);
        r.imported++;
        if (r.imported % 100 === 0) log(`   ...${r.imported} sp đã đẩy`);
      }
      try {
        const m = await fs.readJson(f + META).catch(() => null);
        if (m && Array.isArray(m.shops) && m.shops.length) { await mergeMeta(localName, m); r.metaMerged++; }
      } catch { /* meta hỏng → bỏ */ }
    }
    log(`✅ ${r.imported} sp MỚI · ${r.dup} trùng · ${r.metaMerged} meta gộp · ${r.invalid} không phải sp`);
    return r;
  } finally {
    for (const d of tmpDirs) await fs.remove(d).catch(() => {});
  }
}
