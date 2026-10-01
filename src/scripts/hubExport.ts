/**
 * Xuất Hub (HUB_DIR) ra 1 file zip để chia sẻ giữa các máy (mỗi máy HUB_DIR khác nhau).
 * Logic ở src/core/hubTransfer.ts (dùng chung với Admin UI → màn Hub → "Xuất zip").
 *
 *   npm run hub:export                              → data/hub-export-<ngày>.zip, toàn bộ
 *   npm run hub:export --since=2026-09-25           → chỉ sp thêm/sửa hoặc meta đổi từ ngày đó (gửi tăng dần)
 *   npm run hub:export --out=D:/share/hub.zip
 * (PowerShell: bỏ dấu `--` sau tên script; npx tsx src/scripts/hubExport.ts --since=... thì giữ.)
 */
import "dotenv/config";
import path from "path";
import { exportHub } from "../core/hubTransfer";
import { config } from "../config";
import { cliArg } from "../utils/cliArgs";

const parseSince = (s?: string): number => {
  if (!s) return 0;
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(n)) throw new Error(`--since không hợp lệ: ${s} (dùng YYYY-MM-DD hoặc ms)`);
  return n;
};

const main = async () => {
  const sinceMs = parseSince(cliArg("since"));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
  const out = path.resolve(cliArg("out") || path.join(process.cwd(), "data", `hub-export-${stamp}.zip`));
  const r = await exportHub({ out, sinceMs });
  console.log(`📦 Hub: ${config.hubDir} · ${r.total} sp tổng · chọn ${r.products} sp, ${r.metas} meta${sinceMs ? ` (since ${new Date(sinceMs).toISOString().slice(0, 10)})` : ""}`);
  if (!r.products) { console.log("Không có gì để xuất."); return; }
  console.log(`✅ ${r.out} (${(r.bytes / 1e6).toFixed(1)} MB) → máy nhận: npm run hub:import-local --from=<file zip>`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
