/**
 * Edge TTS (free, không cần API key) qua package msedge-tts v2.
 * Trả mp3 + word timestamps từ WordBoundary metadata; nếu metadata thiếu
 * → fallback estimateWordTimings.
 *
 * Bọc sau interface TtsEngine để sau này swap OpenAI TTS chỉ sửa file này.
 */
import fs from "fs-extra";
import path from "path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { estimateWordTimings, TtsWord } from "./estimateWords";
import { probeDurationMs } from "../../utils/ffprobe";

export type { TtsWord };

export interface TtsResult {
  file: string;
  words: TtsWord[];
  durationMs: number;
}

export interface TtsEngine {
  synthesize(text: string, voice: string, outFile: string): Promise<TtsResult>;
}

/** Pool giọng en-US neural — random theo seed video ở videoQueue. */
export const VOICE_POOL = [
  "en-US-JennyNeural",
  "en-US-AriaNeural",
  "en-US-MichelleNeural",
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
];

/** Parse metadata chunk của Edge (JSON có mảng Metadata[].Type="WordBoundary"). Offset/Duration tính bằng tick 100ns. */
function parseWordBoundaries(chunks: string[]): TtsWord[] {
  const words: TtsWord[] = [];
  for (const raw of chunks) {
    try {
      const obj = JSON.parse(raw);
      for (const m of obj?.Metadata ?? []) {
        if (m?.Type !== "WordBoundary") continue;
        const d = m.Data ?? {};
        const startMs = Math.round((d.Offset ?? 0) / 10000);
        const durMs = Math.round((d.Duration ?? 0) / 10000);
        const text = d?.text?.Text ?? "";
        if (text) words.push({ text, startMs, endMs: startMs + durMs });
      }
    } catch { /* chunk không phải JSON hoàn chỉnh → bỏ */ }
  }
  return words;
}

async function synthesizeOnce(text: string, voice: string, outFile: string): Promise<TtsResult> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
  });

  const { audioStream, metadataStream } = tts.toStream(text);

  const metaChunks: string[] = [];
  if (metadataStream) {
    metadataStream.on("data", (c: any) => metaChunks.push(String(c)));
    metadataStream.on("error", () => { /* metadata lỗi không chặn audio */ });
  }

  const audioBufs: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge TTS timeout 60s")), 60_000);
    timer.unref();
    audioStream.on("data", (c: Buffer) => audioBufs.push(c));
    audioStream.on("end", () => { clearTimeout(timer); resolve(); });
    audioStream.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
  tts.close();

  const audio = Buffer.concat(audioBufs);
  if (audio.length < 1000) throw new Error(`Edge TTS trả audio quá ngắn (${audio.length} bytes)`);
  await fs.ensureDir(path.dirname(outFile));
  await fs.writeFile(outFile, audio);

  const durationMs = await probeDurationMs(outFile);
  let words = parseWordBoundaries(metaChunks);
  // metadata thiếu/lệch quá nhiều so với số từ thật → dùng ước lượng
  const nTokens = text.split(/\s+/).filter(Boolean).length;
  if (words.length < nTokens * 0.7) {
    console.warn(`⚠️ [TTS] WordBoundary chỉ có ${words.length}/${nTokens} từ → dùng ước lượng.`);
    words = estimateWordTimings(text, durationMs);
  }
  return { file: outFile, words, durationMs };
}

export const edgeTtsEngine: TtsEngine = {
  /** Retry 3 lần (service free chập chờn), backoff 2s/4s. */
  async synthesize(text, voice, outFile) {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await synthesizeOnce(text, voice, outFile);
      } catch (e: any) {
        lastErr = e;
        console.warn(`⚠️ [TTS] Lần ${attempt}/3 lỗi: ${e?.message ?? e}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    throw new Error(`Edge TTS thất bại sau 3 lần: ${lastErr?.message ?? lastErr}`);
  },
};
