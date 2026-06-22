import * as fs from "fs-extra";
import * as path from "path";
import { config } from "../config";
import { workerConfig, reloadAppConfig } from "../config/appConfig";
import { getAllUsersForCron } from "../state/userDirs";
import { buildPodListing } from "../core/pod/buildPodListing";
import { dispatchScrapedData } from "../core/scrapeViaKiki";
import { refreshQueueSnapshot } from "../state/queueState";

const IMG_EXT = /\.(png|jpe?g|webp)$/i;
const SKIP_DIRS = new Set(["Processed", "Failed"]);

/** Tìm baseSheinAutoDir chứa shop: ưu tiên user khai shop trong profiles, fallback user catch-all. */
const resolveBaseDir = (
  shop: string,
  users: { baseSheinAutoDir: string; profiles: string[] }[]
): string | null => {
  const strong = users.find((u) => u.profiles.includes(shop));
  if (strong) return strong.baseSheinAutoDir;
  const catchAll = users.find((u) => u.profiles.length === 0);
  return catchAll?.baseSheinAutoDir ?? null;
};

/**
 * Build 1 listing POD từ 1 ảnh design + đẩy vào queue của shop. Dùng chung cho:
 *  - quét folder inbox (runPodRouterOnce)
 *  - upload kéo-thả từ Admin UI (POST /admin/api/pod/create)
 * Throw nếu không tìm được baseDir của shop hoặc build/host ảnh lỗi.
 */
export async function ingestPodDesign(opts: {
  shop: string;
  title: string;
  designPath: string;
}): Promise<{ file: string; colors: number }> {
  const users = await getAllUsersForCron();
  const baseDir = resolveBaseDir(opts.shop, users);
  if (!baseDir) throw new Error(`Không tìm thấy baseSheinAutoDir cho shop "${opts.shop}"`);
  const data = await buildPodListing({ designPath: opts.designPath, title: opts.title });
  const [written] = await dispatchScrapedData(baseDir, data, [opts.shop]);
  refreshQueueSnapshot().catch(() => {});
  return { file: written?.file ?? "", colors: data.listing_variations.colors.length };
}

/**
 * Quét POD inbox: POD_INBOX_DIR/<shop>/<title>.{png,jpg,webp}. Mỗi ảnh = 1 listing.
 *  - build JSON (host design + material random lên imgbb) → ghi vào baseSheinAutoDir/<shop>/
 *    (queueManager sẽ nhặt & publish) → move ảnh sang Processed/.
 *  - Lỗi 1 ảnh → move Failed/ + .error.log, KHÔNG chặn ảnh khác.
 *
 * @param opts.force  true = chạy bất kể autoCron (dùng cho nút "Quét POD" thủ công).
 */
export async function runPodRouterOnce(opts?: { force?: boolean }): Promise<{ created: number; failed: number }> {
  reloadAppConfig();
  const out = { created: 0, failed: 0 };
  if (!opts?.force && !workerConfig().autoCron) return out; // cron tự động tôn trọng toggle
  if (!config.podInboxDir) return out;
  if (!(await fs.pathExists(config.podInboxDir))) return out;

  const users = await getAllUsersForCron();
  if (users.length === 0) return out;

  console.log(`\n--- [${new Date().toLocaleTimeString()}] QUÉT POD INBOX ---`);

  const shops = (await fs.readdir(config.podInboxDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith("."))
    .map((d) => d.name);

  for (const shop of shops) {
    const shopDir = path.join(config.podInboxDir, shop);
    const baseDir = resolveBaseDir(shop, users);
    const designs = (await fs.readdir(shopDir)).filter((f) => IMG_EXT.test(f));
    if (designs.length === 0) continue;

    if (!baseDir) {
      console.warn(`   ⚠️ [POD] Không tìm thấy baseDir cho shop "${shop}" — bỏ qua ${designs.length} ảnh.`);
      continue;
    }

    for (const fileName of designs) {
      const designPath = path.join(shopDir, fileName);
      const title = path.basename(fileName, path.extname(fileName)).trim();
      try {
        const r = await ingestPodDesign({ shop, title, designPath });
        console.log(`   ✅ [POD] ${shop}: "${title}" · ${r.colors} màu → ${r.file}`);
        const doneDir = path.join(shopDir, "Processed");
        await fs.ensureDir(doneDir);
        await fs.move(designPath, path.join(doneDir, fileName), { overwrite: true });
        out.created++;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error(`   ❌ [POD] ${shop}/${fileName}: ${msg}`);
        const failDir = path.join(shopDir, "Failed");
        await fs.ensureDir(failDir);
        await fs.move(designPath, path.join(failDir, fileName), { overwrite: true }).catch(() => {});
        await fs.writeFile(path.join(failDir, `${fileName}.error.log`), msg, "utf-8").catch(() => {});
        out.failed++;
      }
    }
  }

  if (out.created > 0 || out.failed > 0) {
    console.log(`--- POD: tạo ${out.created} listing, lỗi ${out.failed}. ---`);
    refreshQueueSnapshot().catch(() => {});
  }
  return out;
}
