/**
 * Test auto-publish 1 video lên TikTok Studio qua Kiki profile.
 *
 * Usage:
 *   # DRY-RUN (khuyên dùng lần đầu): làm hết TRỪ nút Post, giữ browser 60s để xem
 *   npx tsx src/scripts/testPublishVideo.ts --id=1 --profile=683ebd75678e4da3f90ceff3 --dry-run
 *
 *   # Test chéo shop (product không thuộc shop đang login) → bỏ qua bước gắn sản phẩm
 *   npx tsx src/scripts/testPublishVideo.ts --id=1 --profile=<id> --dry-run --skip-product
 *
 *   # ĐĂNG THẬT
 *   npx tsx src/scripts/testPublishVideo.ts --id=1 --profile=<id>
 *
 * ⚠️ Cần Kiki app đang chạy + profile đã login TikTok (tài khoản có TikTok Shop).
 */
import "dotenv/config";
import { VideoDb } from "../state/videoDb";
import { publishVideo } from "../core/videoStudio/publishVideo";
import { buildCaption } from "../core/videoStudio/buildCaption";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k: string) => process.argv.includes(`--${k}`);

const main = async () => {
  const id = parseInt(arg("id") ?? "0");
  const profileId = arg("profile") ?? "";
  if (!id || !profileId) throw new Error("Cần --id=<videoId> --profile=<kikiProfileId>");

  const db = new VideoDb();
  const row = db.get(id);
  db.close();
  if (!row) throw new Error(`Không có video #${id}`);
  if (!row.file) throw new Error(`Video #${id} chưa render xong (status=${row.status})`);

  const script = row.script_json ? JSON.parse(row.script_json) : null;
  const caption = buildCaption({ title: row.title, seed: row.seed, script });

  console.log(`🎬 Video #${id} — ${row.title.slice(0, 60)}`);
  console.log(`   shop=${row.shop} · productId=${row.product_id}`);
  console.log(`   file=${row.file}`);
  console.log(`   caption:\n${caption.split("\n").map((l) => "     " + l).join("\n")}`);
  console.log(`   dryRun=${has("dry-run")} skipProduct=${has("skip-product")}\n`);

  const r = await publishVideo({
    profileId,
    videoId: id,
    videoFile: row.file,
    caption,
    productId: row.product_id,
    dryRun: has("dry-run"),
    skipProduct: has("skip-product"),
    noWarmup: has("no-warmup"),
    holdAfterPostMs: arg("hold") ? parseInt(arg("hold")!) * 1000 : undefined,
    debugShots: has("shots"),
    onLog: (m) => console.log(m),
  });

  if (r.posted) {
    const db2 = new VideoDb();
    db2.markPosted(id);
    db2.close();
    console.log(`\n✅ ĐÃ ĐĂNG + đánh dấu posted trong DB.`);
  } else {
    console.log(`\n🧪 Dry-run xong (chưa đăng, chưa đổi DB).`);
  }
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
