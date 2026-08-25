/**
 * Queue tuần tự Video Studio (1 render 1 lúc — ffmpeg ăn full CPU).
 * Pipeline per video: images → script → tts → render. Artifacts trên disk
 * (ảnh/script/voice) tái dùng khi retry — chạy lại từ step fail.
 * Hook style random theo seed (A/B test) + bơm stats THẬT (pv/orders 28d)
 * vào kịch bản social_proof. Progress qua console.log (đã tap eventBus → SSE).
 */
import fs from "fs-extra";
import path from "path";
import cron from "node-cron";
import { VideoDb } from "../../state/videoDb";
import { resolveAccountForShop } from "../../state/fourSellerAccounts";
import { fetchImages } from "./fetchImages";
import {
  genVideoScript, scriptToText, validateScript, VideoScript, HookStyle, HOOK_STYLES,
} from "../../services/gemini/genVideoScript";
import { edgeTtsEngine, VOICE_POOL } from "../../services/tts/edgeTts";
import { buildAss } from "./buildAss";
import { planSegments } from "./renderPlan";
import { renderVideo } from "./renderVideo";
import { seededRng, seededPick, seededShuffle } from "./rand";

const VIDEOS_DIR = path.resolve(process.cwd(), "data", "videos");
const MUSIC_DIR = path.join(VIDEOS_DIR, "music");
const ASSETS_DIR = path.join(VIDEOS_DIR, "assets");

export interface CreateVideoItem {
  productId: string;
  listingId: string;
  title: string;
  /** mainImage pipe-separated từ list record — fallback khi detail không trả ảnh. */
  mainImage?: string;
  /** Stats thật cho kịch bản social_proof. */
  pv?: number;
  orders?: number;
}

const safeName = (s: string) => s.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "shop";

/** Meta per-product lưu cạnh ảnh cache: fallback ảnh + stats cho script. */
interface ProductMeta { mainImage?: string; pv?: number; orders?: number }

class VideoQueue {
  private running = false;

  /** Tạo rows queued + kick worker. Trả về ids. */
  enqueue(shop: string, items: CreateVideoItem[]): number[] {
    const db = new VideoDb();
    try {
      const ids = items.map((it) => {
        const seed = `${it.productId}:${Date.now() % 1_000_000}:${Math.floor(Math.random() * 1000)}`;
        const hookStyle = seededPick(seededRng(`hookstyle:${seed}`), Object.keys(HOOK_STYLES) as HookStyle[]);
        const id = db.create({
          shop, productId: it.productId, listingId: it.listingId, title: it.title, seed, hookStyle,
        });
        const meta: ProductMeta = { mainImage: it.mainImage, pv: it.pv, orders: it.orders };
        fs.ensureDirSync(path.join(ASSETS_DIR, it.productId));
        fs.writeJsonSync(path.join(ASSETS_DIR, it.productId, "meta.json"), meta);
        return id;
      });
      this.kick();
      return ids;
    } finally { db.close(); }
  }

  retry(id: number): void {
    const db = new VideoDb();
    try {
      const row = db.get(id);
      if (!row) throw new Error(`Không có video #${id}`);
      db.setStatus(id, { status: "queued", error: null });
      this.kick();
    } finally { db.close(); }
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    setImmediate(() => this.loop().finally(() => { this.running = false; }));
  }

  /** Cho cron gọi để nhặt video queued do tiến trình khác tạo. */
  kickPublic(): void { this.kick(); }

  private async loop(): Promise<void> {
    for (;;) {
      // NHẬN việc nguyên tử (UPDATE…RETURNING) — nhiều tiến trình cùng chạy queue
      // (script gen hàng loạt + cron server) nên đọc-rồi-ghi sẽ render trùng video.
      const db = new VideoDb();
      const next = db.claimNextQueued();
      db.close();
      if (!next) return;
      try {
        await this.process(next.id);
      } catch (e: any) {
        console.error(`❌ [Video #${next.id}] ${e?.message ?? e}`);
      }
    }
  }

  private async process(id: number): Promise<void> {
    const db = new VideoDb();
    try {
      // Video đã được claimNextQueued() đổi sang 'generating' → KHÔNG check 'queued' nữa.
      const row = db.get(id);
      if (!row) return;
      const seed = row.seed;
      const account = await resolveAccountForShop(row.shop);
      if (!account) throw new Error(`Shop "${row.shop}" không có tài khoản 4Seller`);
      const principal = `acct:${account.uid}`;
      const workDir = path.join(ASSETS_DIR, row.product_id, String(id));
      await fs.ensureDir(workDir);
      const metaFile = path.join(ASSETS_DIR, row.product_id, "meta.json");
      const meta: ProductMeta = (await fs.pathExists(metaFile)) ? await fs.readJson(metaFile) : {};

      let step = "images";
      try {
        // ── 1. Ảnh ──
        db.setStatus(id, { status: "generating", step });
        console.log(`🎬 [Video #${id}] ${row.title.slice(0, 50)} — bước ảnh`);
        const { files: images } = await fetchImages({
          principal, listingId: row.listing_id, productId: row.product_id,
          videoId: id, seed, mainImage: meta.mainImage,
        });
        console.log(`   ✅ ${images.length} ảnh`);

        // ── 2. Script (tái dùng nếu đã có) ──
        step = "script";
        db.setStatus(id, { status: "generating", step });
        let script: VideoScript;
        if (row.script_json) {
          script = validateScript(JSON.parse(row.script_json));
          console.log(`   💾 Tái dùng script cũ`);
        } else {
          const style = (row.hook_style as HookStyle) || "tease";
          script = await genVideoScript(row.title, {
            stats: { pv28d: meta.pv, orders28d: meta.orders },
          }, style);
          db.setScript(id, JSON.stringify(script));
          console.log(`   ✅ Script [${style}]: "${script.hook}"`);
        }

        // ── 3. TTS (tái dùng nếu voice.mp3 + words.json đã có) ──
        step = "tts";
        db.setStatus(id, { status: "generating", step });
        const voicePath = path.join(workDir, "voice.mp3");
        const wordsPath = path.join(workDir, "words.json");
        let words, durationMs, voiceName;
        if ((await fs.pathExists(voicePath)) && (await fs.pathExists(wordsPath))) {
          ({ words, durationMs, voiceName } = await fs.readJson(wordsPath));
          console.log(`   💾 Tái dùng voice cũ (${voiceName})`);
        } else {
          voiceName = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
          const r = await edgeTtsEngine.synthesize(scriptToText(script), voiceName, voicePath);
          words = r.words; durationMs = r.durationMs;
          await fs.writeJson(wordsPath, { words, durationMs, voiceName });
          console.log(`   ✅ TTS ${voiceName}, ${Math.round(durationMs / 1000)}s`);
        }
        db.setStatus(id, { status: "generating", step, voice: voiceName });

        // ── 4. Render ──
        step = "render";
        db.setStatus(id, { status: "generating", step });
        const plan = planSegments(images.length, durationMs);
        const ordered = seededShuffle(seededRng(`order:${seed}`), images);
        const segImages = Array.from({ length: plan.n }, (_, i) => ordered[i % ordered.length]);
        const assPath = path.join(workDir, "captions.ass");
        await fs.writeFile(assPath, buildAss({
          words, hook: script.hook, cta: script.cta, openLoop: script.openLoop,
          totalMs: Math.round(plan.totalSec * 1000), seed,
        }), "utf-8");
        const music = await pickMusic(seededRng(`music:${seed}`));
        const outPath = path.join(VIDEOS_DIR, safeName(row.shop), `${row.product_id}_${id}.mp4`);
        console.log(`   🎬 Render ${plan.n} segments, ${plan.totalSec}s${music ? ", nhạc: " + path.basename(music) : ", không nhạc"}`);
        await renderVideo({ images: segImages, plan, voicePath, musicPath: music, assPath, outPath, seed });

        db.setStatus(id, { status: "ready", file: outPath });
        console.log(`✅ [Video #${id}] READY → ${outPath}`);
      } catch (e: any) {
        db.setStatus(id, { status: "error", step, error: String(e?.message ?? e).slice(0, 500) });
        console.error(`❌ [Video #${id}] bước "${step}": ${e?.message ?? e}`);
      }
    } finally { db.close(); }
  }
}

async function pickMusic(rng: () => number): Promise<string | null> {
  try {
    const files = (await fs.readdir(MUSIC_DIR)).filter((f) => /\.mp3$/i.test(f));
    if (!files.length) return null;
    return path.join(MUSIC_DIR, seededPick(rng, files));
  } catch { return null; } // thư mục chưa tồn tại → không nhạc, không lỗi
}

export const videoQueue = new VideoQueue();

/**
 * Cron 5′: nhặt video còn `queued` trong DB rồi chạy tiếp.
 * Cần vì video có thể được enqueue từ TIẾN TRÌNH KHÁC (script gen hàng loạt) —
 * script đó chết giữa chừng thì video sẽ nằm im mãi nếu server không tự quét.
 * Cũng cứu các video đang `generating` khi server bị kill giữa lúc render.
 */
export function scheduleVideoQueueCron(): void {
  // Máy không phụ trách video (vd máy cũ sau khi chuyển video studio sang máy mới)
  // → set .env DISABLE_VIDEO_STUDIO_CRON=1. Dùng .env vì file này KHÔNG vào git
  // (config/*.json đi chung repo 2 máy — tắt bằng config sẽ lây sang máy kia khi pull).
  if (process.env.DISABLE_VIDEO_STUDIO_CRON === "1") {
    console.log("⏰ Cron quét queue video: TẮT (.env → DISABLE_VIDEO_STUDIO_CRON=1)");
    return;
  }
  cron.schedule("*/5 * * * *", () => {
    const db = new VideoDb();
    try {
      // generating quá 20 phút = tiến trình render đã chết → trả về queued
      const stale = db.db.prepare(
        `SELECT id FROM videos WHERE status='generating' AND updated_at < ?`
      ).all(Date.now() - 20 * 60_000) as { id: number }[];
      for (const r of stale) {
        console.warn(`⚠️ [VideoQueue] #${r.id} kẹt ở generating > 20′ → đưa lại vào queue`);
        db.setStatus(r.id, { status: "queued", error: null });
      }
      const pending = db.list({ status: "queued", limit: 1 }).length;
      if (pending) videoQueue.kickPublic();
    } catch (e: any) {
      console.error(`❌ [VideoQueueCron] ${e?.message ?? e}`);
    } finally { db.close(); }
  });
  console.log("⏰ Cron quét queue video đã đăng ký (mỗi 5′).");
}
