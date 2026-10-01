/**
 * Xuất Hub (HUB_DIR) ra 1 file zip để chia sẻ giữa các máy (mỗi máy HUB_DIR khác nhau).
 * Gồm file sản phẩm hub_*.json + sidecar .hubmeta.json (đã list vào shop nào) + manifest.json.
 * Máy nhận chạy: npm run hub:import-local --from=<file.zip>
 *
 *   npm run hub:export                              → data/hub-export-<ngày>.zip, toàn bộ
 *   npm run hub:export --since=2026-09-25           → chỉ sp thêm/sửa hoặc meta đổi từ ngày đó (gửi tăng dần)
 *   npm run hub:export --out=D:/share/hub.zip
 * (PowerShell: bỏ dấu `--` sau tên script; npx tsx src/scripts/hubExport.ts --since=... thì giữ.)
 *
 * ponytail: tar.exe có sẵn của Windows (bsdtar) nén THẲNG từ HUB_DIR theo danh sách file (-T), không copy ra tạm.
 * Không có tar → copy ra tạm + Compress-Archive (chậm ~3 phút).
 */
import "dotenv/config";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { config } from "../config";
import { cliArg } from "../utils/cliArgs";

const META = ".hubmeta.json";
const isMeta = (f: string) => f.endsWith(META) || f === "__hub_meta.json";
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

const parseSince = (s?: string): number => {
  if (!s) return 0;
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(n)) throw new Error(`--since không hợp lệ: ${s} (dùng YYYY-MM-DD hoặc ms)`);
  return n;
};

/** Gom file vào thư mục tạm bằng HARD LINK (tức thì, cùng ổ đĩa); khác ổ / lỗi → copy.
 *  bsdtar Windows đọc danh sách -T bị lỗi (ra tên rác) nên không dùng -T; nén cả thư mục tạm. */
const stageFiles = async (hub: string, names: string[], stage: string): Promise<void> => {
  for (const n of names) {
    const src = path.join(hub, n), dst = path.join(stage, n);
    try { await fs.link(src, dst); } catch { await fs.copy(src, dst); }
  }
};

const zipWithTar = (stage: string, out: string): void => {
  execFileSync(TAR, ["-a", "-cf", out, "-C", stage, "."], { stdio: "inherit" });
};

/** Fallback không có tar: Compress-Archive (chậm với nhiều file nhỏ). */
const zipWithPowershell = (stage: string, out: string): void => {
  const q = (x: string) => x.replace(/'/g, "''");
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${q(stage)}\\*' -DestinationPath '${q(out)}' -Force`], { stdio: "inherit" });
};

const main = async () => {
  const sinceMs = parseSince(cliArg("since"));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
  const out = path.resolve(cliArg("out") || path.join(process.cwd(), "data", `hub-export-${stamp}.zip`));
  const hub = config.hubDir;
  if (!(await fs.pathExists(hub))) throw new Error(`HUB_DIR không tồn tại: ${hub}`);

  const names = (await fs.readdir(hub)).filter((f) => f.endsWith(".json") && !isMeta(f));
  const pick: string[] = []; // tên file (sp + meta) sẽ vào zip
  let products = 0, metas = 0;
  for (const f of names) {
    const st = await fs.stat(path.join(hub, f));
    const mst = await fs.stat(path.join(hub, f + META)).catch(() => null);
    // Tăng dần: lấy sp mới/sửa, HOẶC meta vừa đổi (vừa list sang shop) dù sp cũ → máy kia biết đã list.
    const fresh = !sinceMs || st.mtimeMs >= sinceMs || (mst?.mtimeMs ?? 0) >= sinceMs;
    if (!fresh) continue;
    pick.push(f); products++;
    if (mst) { pick.push(f + META); metas++; }
  }
  console.log(`📦 Hub: ${hub} · ${names.length} sp tổng · chọn ${products} sp, ${metas} meta${sinceMs ? ` (since ${new Date(sinceMs).toISOString().slice(0, 10)})` : ""}`);
  if (!products) { console.log("Không có gì để xuất."); return; }

  const stage = path.join(os.tmpdir(), `hub-export-${Date.now()}`); // hard link sp + meta + manifest.json
  await fs.ensureDir(stage);
  await stageFiles(hub, pick, stage);
  await fs.writeJson(path.join(stage, "manifest.json"), {
    exportedAt: new Date().toISOString(), host: os.hostname(), hubDir: hub, sinceMs, products, metas,
  }, { spaces: 2 });
  await fs.ensureDir(path.dirname(out));
  try {
    await fs.remove(out);
    if (await fs.pathExists(TAR)) zipWithTar(stage, out);
    else zipWithPowershell(stage, out);
    const mb = ((await fs.stat(out)).size / 1e6).toFixed(1);
    console.log(`✅ ${out} (${mb} MB) → máy nhận: npm run hub:import-local --from=<file zip>`);
  } catch (e: any) {
    console.warn(`⚠️ Không zip được: ${e?.message ?? e}. Có thể copy thẳng thư mục ${hub} sang máy kia rồi import từ thư mục.`);
  } finally {
    await fs.remove(stage).catch(() => {});
  }
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
