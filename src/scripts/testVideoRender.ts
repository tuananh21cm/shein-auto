/**
 * Smoke test Video Studio KHÔNG cần 4Seller/Gemini: ảnh mẫu trong repo +
 * script hardcode + Edge TTS thật + render ffmpeg thật.
 *
 * Usage:
 *   npx tsx src/scripts/testVideoRender.ts                    → render variant "tease"
 *   npx tsx src/scripts/testVideoRender.ts --variant=all      → render ĐỦ 6 kịch bản hook
 *   npx tsx src/scripts/testVideoRender.ts --variant=viral    → 1 kịch bản cụ thể
 *   npx tsx src/scripts/testVideoRender.ts --no-tts           → offline (audio im lặng)
 *
 * Output: data/videos/_smoke/demo_<variant>.mp4 — dùng để A/B test xem
 * kịch bản hook nào giữ chân khách tốt nhất trước khi nối vào Gemini thật.
 */
import "dotenv/config";
import path from "path";
import fs from "fs-extra";
import { execFile } from "child_process";
import { edgeTtsEngine, VOICE_POOL } from "../services/tts/edgeTts";
import { estimateWordTimings } from "../services/tts/estimateWords";
import { scriptToText, VideoScript, HookStyle } from "../services/gemini/genVideoScript";
import { buildAss } from "../core/videoStudio/buildAss";
import { planSegments } from "../core/videoStudio/renderPlan";
import { renderVideo } from "../core/videoStudio/renderVideo";
import { seededRng, seededShuffle, seededPick } from "../core/videoStudio/rand";

const SAMPLE_DIR = path.resolve(process.cwd(), "src", "core", "steps", "temp_images_a6e6dd02e280840e");
const OUT_DIR = path.resolve(process.cwd(), "data", "videos", "_smoke");

/**
 * 6 kịch bản demo — cùng 1 sản phẩm (váy mẫu) để so sánh công bằng.
 * LƯU Ý: số liệu trong social_proof là số DEMO. Bản production genVideoScript
 * sẽ bơm số THẬT từ listing_views (pv_28d/orders_28d); không có số thì dùng
 * phrasing không kiểm chứng được ("orders keep rolling in").
 */
const DEMO_SCRIPTS: Record<HookStyle, VideoScript> = {
  social_proof: {
    hook: "One thousand carts in week one. This dress.",
    openLoop: "And the number one reason is not what you think.",
    lines: [
      "Everyone assumes it's the price. Nope.",
      "The ruched waist flatters literally every body type.",
      "The fabric doesn't wrinkle, doesn't cling, doesn't fade.",
      "The real reason? It photographs insanely well. Your feed will eat this up.",
    ],
    cta: "Tap the cart before the next restock sells through!",
  },
  viral: {
    hook: "Okay, TikTok made me buy this dress. I get it now.",
    openLoop: "Stay till the end for what surprised me most.",
    lines: [
      "You've probably seen this all over your feed this week.",
      "The fabric feels way more expensive than it has any right to.",
      "It went from brunch to beach without a single wrinkle.",
      "But what surprised me most? The back. Nobody warns you about the back. It's stunning.",
    ],
    cta: "Get yours before it sells out again!",
  },
  tease: {
    hook: "Wait till you see the back of this dress",
    openLoop: "Stay till the end, the last detail sold me.",
    lines: [
      "The fabric is so soft it feels like a cloud.",
      "That ruched waist? Flattering on literally everyone.",
      "Wear it to brunch, the beach, or date night.",
      "And THAT back detail? Yeah. That's what sold me.",
    ],
    cta: "Tap the cart before it sells out!",
  },
  callout: {
    hook: "If every dress swallows your waist, stop scrolling.",
    openLoop: "This one fixes it. Wait for the proof.",
    lines: [
      "Most summer dresses hang like a pillowcase. This one doesn't.",
      "The ruched waist pulls everything in exactly where you want it.",
      "Stretchy enough for brunch. Structured enough for photos.",
      "And here's the proof: look at that waistline. That's the dress doing all the work.",
    ],
    cta: "Tap the cart and thank me later!",
  },
  storytime: {
    hook: "Three strangers stopped me at brunch over this dress.",
    openLoop: "The third one made me laugh. Stick around.",
    lines: [
      "First one asked if it was designer. Not even close.",
      "Second one took a photo of the tag. There was no tag.",
      "It's the ruching. It makes any body look sculpted.",
      "And the third stranger? She ordered it at the table before we finished talking.",
    ],
    cta: "Join her. Tap the cart now!",
  },
  listicle: {
    hook: "Three reasons this is THE dress of summer.",
    openLoop: "Number three is why it keeps selling out.",
    lines: [
      "One: the fabric is soft, stretchy, and never wrinkles.",
      "Two: the ruched waist flatters literally every body type.",
      "Three: it photographs like a dress five times the price.",
      "That's why it keeps selling out. Simple.",
    ],
    cta: "Tap the cart before the next restock sells through!",
  },
};

const makeSilence = (file: string, sec: number) =>
  new Promise<void>((res, rej) =>
    execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", String(sec), file],
      (e) => (e ? rej(e) : res())));

async function renderOne(name: string, script: VideoScript, images: string[], noTts: boolean): Promise<string> {
  const seed = `demo:${name}`;
  const text = scriptToText(script);
  const voicePath = path.join(OUT_DIR, `voice_${name}.mp3`);
  let words, durationMs;
  if (noTts) {
    durationMs = 22000;
    await makeSilence(voicePath, durationMs / 1000);
    words = estimateWordTimings(text, durationMs);
  } else {
    const voice = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
    console.log(`🎙️ [${name}] Edge TTS voice=${voice}…`);
    const r = await edgeTtsEngine.synthesize(text, voice, voicePath);
    words = r.words; durationMs = r.durationMs;
  }

  const plan = planSegments(images.length, durationMs);
  const ordered = seededShuffle(seededRng(`order:${seed}`), images);
  const segImages = Array.from({ length: plan.n }, (_, i) => ordered[i % ordered.length]);

  const assPath = path.join(OUT_DIR, `captions_${name}.ass`);
  await fs.writeFile(assPath, buildAss({
    words, hook: script.hook, cta: script.cta, openLoop: script.openLoop,
    totalMs: Math.round(plan.totalSec * 1000), seed,
  }), "utf-8");

  const outPath = path.join(OUT_DIR, `demo_${name}.mp4`);
  console.log(`🎬 [${name}] Render ${plan.n} segments, ${plan.totalSec}s…`);
  const t0 = Date.now();
  await renderVideo({ images: segImages, plan, voicePath, musicPath: null, assPath, outPath, seed });
  console.log(`✅ [${name}] ${Math.round((Date.now() - t0) / 1000)}s → ${outPath}`);
  return outPath;
}

const main = async () => {
  const noTts = process.argv.includes("--no-tts");
  const variantArg = process.argv.find((a) => a.startsWith("--variant="))?.slice(10) || "tease";
  await fs.ensureDir(OUT_DIR);

  const images = (await fs.readdir(SAMPLE_DIR)).filter((f) => /^img_\d+\.jpg$/.test(f)).map((f) => path.join(SAMPLE_DIR, f));
  if (images.length < 3) throw new Error(`Cần ≥3 ảnh mẫu trong ${SAMPLE_DIR}`);
  console.log(`🖼️ ${images.length} ảnh mẫu`);

  const names = variantArg === "all" ? (Object.keys(DEMO_SCRIPTS) as HookStyle[]) : [variantArg as HookStyle];
  for (const name of names) {
    const script = DEMO_SCRIPTS[name];
    if (!script) throw new Error(`Không có variant "${name}". Có: ${Object.keys(DEMO_SCRIPTS).join(", ")}, all`);
    await renderOne(name, script, images, noTts);
  }
  console.log(`\n🏁 Xong ${names.length} video → ${OUT_DIR}`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
