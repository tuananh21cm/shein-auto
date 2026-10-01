/**
 * Nhập sản phẩm vào Hub (HUB_DIR) từ thư mục hoặc FILE ZIP do máy khác xuất (npm run hub:export).
 * Logic ở src/core/hubTransfer.ts (dùng chung với Admin UI → màn Hub → "Nhập zip"):
 * dedup theo productId (sp không url → băm tên+ảnh), gộp .hubmeta (đã list shop nào) theo productId.
 *
 *   npm run hub:import-local --from=D:/nhan/hub-export-20261001.zip
 *   npm run hub:import-local --from='C:/old hub,D:/backup' --by=duc
 * Mặc định nguồn = data/hub + BASE_SHEINAUTO_DIR (đẩy data cũ máy local lên hub chung).
 * (PowerShell: bỏ dấu `--` sau tên script; npx tsx ... thì giữ.)
 */
import "dotenv/config";
import path from "path";
import { importHub } from "../core/hubTransfer";
import { config } from "../config";
import { cliArg } from "../utils/cliArgs";

const main = async () => {
  const by = (cliArg("by") || "").trim() || "import";
  const froms = (cliArg("from") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sources = (froms.length ? froms : [path.resolve(process.cwd(), "data", "hub"), config.baseSheinAutoDir]).filter(Boolean) as string[];
  console.log("👤 addedBy       :", by);
  console.log("📦 Hub đích       :", config.hubDir);
  console.log("📂 Nguồn          :", sources.join("  ·  "));
  if (!process.env.HUB_DIR) console.warn("⚠️  HUB_DIR chưa set → đang nhập vào hub LOCAL data/hub.\n");
  const r = await importHub({ sources, by, log: (m) => console.log(m) });
  console.log(`\n✅ Xong: ${r.imported} sp MỚI vào hub · ${r.dup} trùng (bỏ) · ${r.metaMerged} meta đã gộp · ${r.invalid} không phải sản phẩm`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
