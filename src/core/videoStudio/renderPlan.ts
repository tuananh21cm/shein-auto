/**
 * Pure logic render: chia video thành N segment ảnh (Ken Burns) nối bằng xfade,
 * và build args ffmpeg hoàn chỉnh. Tách pure để unit-test không cần chạy ffmpeg.
 *
 * Cấu trúc filtergraph:
 *   mỗi ảnh: scale 2x → zoompan (chống jitter) → 1080x1920@30fps
 *   nối: xfade dây chuyền, offset_m = sum(d_0..d_{m-1}) − m·fade
 *   cuối: ass=caption, format=yuv420p
 *   audio: voice apad tới total (+ nhạc nền loop, volume 0.18, amix)
 */
import { seededRng, seededPick } from "./rand";

export interface SegmentPlan {
  n: number;            // số segment
  durations: number[];  // giây, gross (đã gồm phần overlap fade)
  fade: number;         // giây
  totalSec: number;     // duration video cuối
  introCount: number;   // số segment intro đầu video (0 nếu không có) → transition intro dùng fade mượt
}

const FADE = 0.4;
const TARGET_SEG = 3.5;   // giây/ảnh lý tưởng
const MIN_SEG = 2.0;
const MAX_SEG = 6.5;
// Hook giữ chân: intro cắt hơi nhanh 3 ảnh đầu rồi vào Ken Burns chậm. 1.4s/ảnh (trước
// là 0.9s — quá nhanh, giật/khó chịu): mỗi ảnh đứng ~1s, zoom chậm hơn, transition intro
// dùng fade mượt (xem buildFfmpegArgs). Chỉ áp dụng khi video đủ dài.
const INTRO_N = 3;
const INTRO_DUR = 1.4;
const INTRO_MIN_TOTAL = 12;

export function planSegments(imageCount: number, voiceMs: number): SegmentPlan {
  const totalSec = voiceMs / 1000 + 0.8; // tail 0.8s sau khi voice hết
  const round2 = (x: number) => Math.round(x * 100) / 100;

  if (totalSec < INTRO_MIN_TOTAL) {
    // Video ngắn: chia đều như cũ, không intro.
    let n = Math.max(2, Math.round(totalSec / TARGET_SEG));
    const gross = (k: number) => (totalSec + FADE * (k - 1)) / k;
    while (n > 2 && gross(n) < MIN_SEG) n--;
    while (gross(n) > MAX_SEG) n++;
    const d = gross(n);
    return { n, durations: Array.from({ length: n }, () => round2(d)), fade: FADE, totalSec: round2(totalSec), introCount: 0 };
  }

  // Intro 3 cắt nhanh + k segment chính:
  // sum(durations) = totalSec + FADE*(n-1) với n = INTRO_N + k
  const introSum = INTRO_N * INTRO_DUR;
  const grossMain = (k: number) => (totalSec + FADE * (INTRO_N + k - 1) - introSum) / k;
  let k = Math.max(2, Math.round((totalSec - introSum) / TARGET_SEG));
  while (k > 2 && grossMain(k) < MIN_SEG) k--;
  while (grossMain(k) > MAX_SEG) k++;
  const d = grossMain(k);
  return {
    n: INTRO_N + k,
    durations: [
      ...Array.from({ length: INTRO_N }, () => INTRO_DUR),
      ...Array.from({ length: k }, () => round2(d)),
    ],
    fade: FADE,
    totalSec: round2(totalSec),
    introCount: INTRO_N,
  };
}

/** Path Windows → dạng ffmpeg filter chấp nhận: slash + escape ':'. */
export const escapeFilterPath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/:/g, "\\:");

const XFADE_TRANSITIONS = ["fade", "slideleft", "slideright", "slideup", "smoothleft", "smoothright"];

/** 4 biến thể Ken Burns; chọn theo seed từng segment. */
const KENBURNS = [
  // zoom in giữa
  (f: number) => `z='min(1+0.12*on/${f},1.12)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom out giữa
  (f: number) => `z='max(1.12-0.12*on/${f},1.001)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trái→phải
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)*on/${f}':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trên→dưới
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*on/${f}'`,
];

export interface FfmpegArgsOpts {
  images: string[];          // đúng plan.n phần tử (queue đã lặp/cắt sẵn)
  plan: SegmentPlan;
  voicePath: string;
  musicPath: string | null;
  assPath: string;
  outPath: string;
  seed: string;
}

export function buildFfmpegArgs(o: FfmpegArgsOpts): string[] {
  const { plan } = o;
  if (o.images.length !== plan.n) throw new Error(`images (${o.images.length}) phải = plan.n (${plan.n})`);
  const rng = seededRng(`render:${o.seed}`);
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

  // Inputs: n ảnh loop
  for (let i = 0; i < plan.n; i++) {
    args.push("-loop", "1", "-t", plan.durations[i].toFixed(2), "-i", o.images[i]);
  }
  const voiceIdx = plan.n;
  args.push("-i", o.voicePath);
  let musicIdx = -1;
  if (o.musicPath) {
    musicIdx = plan.n + 1;
    args.push("-stream_loop", "-1", "-i", o.musicPath);
  }

  // Video chains
  const parts: string[] = [];
  for (let i = 0; i < plan.n; i++) {
    const frames = Math.max(1, Math.round(plan.durations[i] * 30));
    const kb = seededPick(rng, KENBURNS)(frames);
    parts.push(
      `[${i}:v]scale=2160:3840:flags=lanczos,zoompan=${kb}:d=${frames}:s=1080x1920:fps=30,settb=AVTB[v${i}]`
    );
  }
  // xfade chain: offset_m = sum(d_0..d_{m-1}) − m·fade
  let prev = "v0";
  let cum = 0;
  for (let m = 1; m < plan.n; m++) {
    cum += plan.durations[m - 1];
    const offset = (cum - m * plan.fade).toFixed(2);
    // Transition dính segment intro (m ≤ introCount) → "fade" mượt, tránh slide/smooth
    // giật ở nhịp nhanh đầu video. Phần thân giữ transition đa dạng theo seed.
    const tr = m <= plan.introCount ? "fade" : seededPick(rng, XFADE_TRANSITIONS);
    const outLbl = m === plan.n - 1 ? "vx" : `x${m}`;
    parts.push(`[${prev}][v${m}]xfade=transition=${tr}:duration=${plan.fade}:offset=${offset}[${outLbl}]`);
    prev = outLbl;
  }
  const vsrc = plan.n === 1 ? "v0" : "vx";
  parts.push(`[${vsrc}]ass='${escapeFilterPath(o.assPath)}',format=yuv420p[vout]`);

  // Audio
  const T = plan.totalSec.toFixed(2);
  if (musicIdx >= 0) {
    parts.push(
      `[${voiceIdx}:a]apad=whole_dur=${T}[va]`,
      `[${musicIdx}:a]volume=0.18,afade=t=out:st=${Math.max(0, plan.totalSec - 1.2).toFixed(2)}:d=1.2[ma]`,
      `[va][ma]amix=inputs=2:duration=first:normalize=0[aout]`
    );
  } else {
    parts.push(`[${voiceIdx}:a]apad=whole_dur=${T}[aout]`);
  }

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", T,
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    o.outPath
  );
  return args;
}
