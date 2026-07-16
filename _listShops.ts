import "dotenv/config";
import * as fs from "fs-extra";
import * as path from "path";
import { processFile } from "./src/queue/queueManager";

const BASE = "C:/Users/KBT/Downloads/SheinAuto";
const SHOPS = ["TA Scan 602_US", "TA Scan 607_US"];
const OWNER = "tuananh"; // fallback; cookie thật resolve per-shop (account tk-2372bccd721e)

async function main() {
  let ok = 0, fail = 0, total = 0;
  for (const shop of SHOPS) {
    const dir = path.join(BASE, shop);
    if (!(await fs.pathExists(dir))) { console.log(`(bỏ) không có folder ${shop}`); continue; }
    const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
    console.log(`\n=== ${shop}: ${files.length} file pending ===`);
    for (const f of files) {
      total++;
      console.log(`\n[${total}] ▶ ${shop} / ${f}`);
      try {
        const ran = await processFile(BASE, shop, f, OWNER);
        // processFile move file → Success (ok) hoặc Fail. Kiểm tra kết quả:
        const inSuccess = await fs.pathExists(path.join(dir, "Success", f));
        if (ran && inSuccess) { ok++; console.log(`   ✅ draft OK`); }
        else if (ran) { fail++; console.log(`   ❌ fail (xem Fail/)`); }
        else { console.log(`   ⏸️ skip (lock)`); }
      } catch (e: any) {
        fail++; console.log(`   ❌ lỗi: ${e.message}`);
      }
    }
  }
  console.log(`\n\n==== XONG: ${ok} draft OK · ${fail} fail · ${total} tổng ====`);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
