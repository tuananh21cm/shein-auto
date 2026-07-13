/**
 * Smoke test Video Studio KHÔNG cần 4Seller/Gemini: ảnh mẫu trong repo +
 * script hardcode + Edge TTS thật + render ffmpeg thật.
 * Usage: npx tsx src/scripts/testVideoRender.ts [--no-tts] [--seed=xxx]
 *   --no-tts: bỏ qua Edge TTS (offline), dùng words ước lượng trên audio im lặng.
 *   --seed  : đổi seed để ra video khác (style/transition/giọng khác).
 */
import "dotenv/config";
import path from "path";
import fs from "fs-extra";
import { execFile } from "child_process";
import { edgeTtsEngine, VOICE_POOL } from "../services/tts/edgeTts";
import { estimateWordTimings } from "../services/tts/estimateWords";
import { scriptToText, VideoScript } from "../services/gemini/genVideoScript";
import { buildAss } from "../core/videoStudio/buildAss";
import { planSegments } from "../core/videoStudio/renderPlan";
import { renderVideo } from "../core/videoStudio/renderVideo";
import { seededRng, seededShuffle, seededPick } from "../core/videoStudio/rand";

const SAMPLE_DIR = path.resolve(process.cwd(), "src", "core", "steps", "temp_images_a6e6dd02e280840e");
const OUT_DIR = path.resolve(process.cwd(), "data", "videos", "_smoke");

const SCRIPT: VideoScript = {
  hook: "POV: you found the perfect summer dress",
  lines: [
    "The fabric is so soft it feels like a cloud.",
    "That ruched waist? Flattering on literally everyone.",
    "Wear it to brunch, the beach, or date night.",
  ],
  cta: "Tap the cart before it sells out!",
};

const makeSilence = (file: string, sec: number) =>
  new Promise<void>((res, rej) =>
    execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", String(sec), file],
      (e) => (e ? rej(e) : res())));

const main = async () => {
  const noTts = process.argv.includes("--no-tts");
  const seed = process.argv.find((a) => a.startsWith("--seed="))?.slice(7) || "smoke:1";
  await fs.ensureDir(OUT_DIR);

  const images = (await fs.readdir(SAMPLE_DIR)).filter((f) => /^img_\d+\.jpg$/.test(f)).map((f) => path.join(SAMPLE_DIR, f));
  if (images.length < 3) throw new Error(`Cần ≥3 ảnh mẫu trong ${SAMPLE_DIR}`);
  console.log(`🖼️ ${images.length} ảnh mẫu`);

  const text = scriptToText(SCRIPT);
  const voicePath = path.join(OUT_DIR, "voice.mp3");
  let words, durationMs;
  if (noTts) {
    durationMs = 20000;
    await makeSilence(voicePath, durationMs / 1000);
    words = estimateWordTimings(text, durationMs);
    console.log("🔇 --no-tts: audio im lặng 20s + words ước lượng");
  } else {
    const voice = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
    console.log(`🎙️ Edge TTS voice=${voice}…`);
    const r = await edgeTtsEngine.synthesize(text, voice, voicePath);
    words = r.words; durationMs = r.durationMs;
    console.log(`   ${Math.round(durationMs / 1000)}s audio, ${words.length} words`);
  }

  const plan = planSegments(images.length, durationMs);
  const ordered = seededShuffle(seededRng(`order:${seed}`), images);
  const segImages = Array.from({ length: plan.n }, (_, i) => ordered[i % ordered.length]);

  const assPath = path.join(OUT_DIR, "captions.ass");
  await fs.writeFile(assPath, buildAss({ words, hook: SCRIPT.hook, cta: SCRIPT.cta, totalMs: Math.round(plan.totalSec * 1000), seed }), "utf-8");

  const outPath = path.join(OUT_DIR, "smoke.mp4");
  console.log(`🎬 Render ${plan.n} segments, ${plan.totalSec}s…`);
  const t0 = Date.now();
  await renderVideo({ images: segImages, plan, voicePath, musicPath: null, assPath, outPath, seed });
  console.log(`✅ Xong sau ${Math.round((Date.now() - t0) / 1000)}s → ${outPath}`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
