/**
 * Test đăng 1 file JSON qua API 4Seller (không Playwright).
 *   npx tsx src/scripts/runOneApi.ts <path> [--dry-run] [--user=<cookieUser>]
 * --dry-run: build payload + upload ảnh, KHÔNG gọi publish; ghi payload ra data/tmp/api-payload.json
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { listing4sellerApi } from "../core/listing4sellerApi";

const main = async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("Usage: npx tsx src/scripts/runOneApi.ts <path> [--dry-run] [--user=X]"); process.exit(1); }
  const dryRun = args.includes("--dry-run");
  const skipImages = args.includes("--skip-images"); // test nhanh: không PUT ảnh lên COS
  const cookieUser = args.find((a) => a.startsWith("--user="))?.slice(7);
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const t0 = Date.now();
  try {
    const r = await listing4sellerApi(abs, { dryRun, cookieUser, skipImages });
    const out = path.join(process.cwd(), "data", "tmp", `api-payload_${path.basename(abs, ".json")}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r.payload, null, 2));
    console.log(`✅ ${dryRun ? "DRY-RUN" : "LIVE listingId=" + r.listingId} in ${Math.round((Date.now() - t0) / 1000)}s · payload → ${out}`);
    process.exit(0);
  } catch (e: any) {
    console.error(`❌ Failed in ${Math.round((Date.now() - t0) / 1000)}s:`, e?.message ?? e);
    process.exit(2);
  }
};
main();
