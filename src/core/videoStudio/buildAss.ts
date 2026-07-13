/**
 * Build file .ass: caption sync theo word timestamps (nhóm 2-4 từ/dòng),
 * hook overlay ~2s đầu, CTA 2.5s cuối. Style chọn theo seed từ 5 preset
 * (font/màu/viền) — font hệ thống Windows, không bundle.
 * Dùng .ass thay drawtext để khỏi escape text trong filtergraph ffmpeg.
 */
import { seededRng, seededPick } from "./rand";
import type { TtsWord } from "../../services/tts/estimateWords";

export interface CaptionLine { text: string; startMs: number; endMs: number }

export const msToAssTime = (ms: number): string => {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
};

/** {} là control code của ASS, \ bắt đầu override → thay bằng ký tự an toàn. */
const escapeAss = (s: string): string =>
  s.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, " ");

/** Nhóm 2-4 từ thành 1 dòng caption (kích thước nhóm random theo seed). */
export function groupWords(words: TtsWord[], seed: string): CaptionLine[] {
  const rng = seededRng(`grp:${seed}`);
  const lines: CaptionLine[] = [];
  let i = 0;
  while (i < words.length) {
    const size = Math.min(2 + Math.floor(rng() * 3), words.length - i); // 2-4
    const grp = words.slice(i, i + size);
    lines.push({
      text: grp.map((w) => w.text).join(" "),
      startMs: grp[0].startMs,
      endMs: grp[grp.length - 1].endMs,
    });
    i += size;
  }
  // kéo endMs của dòng tới startMs dòng sau (đỡ nháy giữa các dòng), không chồng lấn
  for (let k = 0; k < lines.length - 1; k++) lines[k].endMs = Math.max(lines[k].endMs, lines[k + 1].startMs);
  return lines;
}

interface StylePreset { name: string; caption: string; hook: string }

/** PrimaryColour ASS = &HAABBGGRR (AA=00 đục). 5 preset đổi font/màu chống trùng template. */
const STYLE_PRESETS: StylePreset[] = [
  { name: "white-impact",
    caption: `Style: Caption,Impact,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,640,1`,
    hook:    `Style: Hook,Impact,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
  { name: "yellow-arialblack",
    caption: `Style: Caption,Arial Black,84,&H0000FFFF,&H0000FFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,640,1`,
    hook:    `Style: Hook,Arial Black,96,&H0000FFFF,&H0000FFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
  { name: "white-verdana-pink",
    caption: `Style: Caption,Verdana,80,&H00FFFFFF,&H00FFFFFF,&H00B469FF,&H7F000000,-1,0,0,0,100,100,0,0,1,7,0,2,60,60,660,1`,
    hook:    `Style: Hook,Verdana,92,&H00FFFFFF,&H00FFFFFF,&H00B469FF,&H7F000000,-1,0,0,0,100,100,0,0,1,8,0,8,60,60,300,1` },
  { name: "black-on-white-tahoma",
    caption: `Style: Caption,Tahoma,80,&H00000000,&H00000000,&H00FFFFFF,&H7F000000,-1,0,0,0,100,100,0,0,3,8,0,2,60,60,640,1`,
    hook:    `Style: Hook,Tahoma,92,&H00000000,&H00000000,&H00FFFFFF,&H7F000000,-1,0,0,0,100,100,0,0,3,9,0,8,60,60,300,1` },
  { name: "mint-segoe",
    caption: `Style: Caption,Segoe UI Black,82,&H00C4F5D8,&H00C4F5D8,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,650,1`,
    hook:    `Style: Hook,Segoe UI Black,94,&H00C4F5D8,&H00C4F5D8,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
];

export function buildAss(opts: {
  words: TtsWord[];
  hook: string;
  cta: string;
  totalMs: number;
  seed: string;
  /** Dòng open-loop treo giữa video ("wait for the end...") giữ chân xem hết. */
  openLoop?: string;
}): string {
  const preset = seededPick(seededRng(`style:${opts.seed}`), STYLE_PRESETS);
  const lines = groupWords(opts.words, opts.seed);

  // Tag animation đặt TRƯỚC text đã escape (escapeAss loại {} \ khỏi nội dung user).
  const popIn = "{\\fscx55\\fscy55\\t(0,180,\\fscx105\\fscy105)\\t(180,280,\\fscx100\\fscy100)}";

  const events: string[] = [];
  // Hook overlay 0 → min(3000ms, 1/3 video), pop-in để bắt mắt ngay frame đầu
  const hookEnd = Math.min(3000, Math.round(opts.totalMs / 3));
  events.push(`Dialogue: 0,${msToAssTime(0)},${msToAssTime(hookEnd)},Hook,,0,0,0,,${popIn}${escapeAss(opts.hook.toUpperCase())}`);
  // Open-loop nhỏ treo trên màn hình từ sau hook tới ~65% video (nhắc payoff cuối)
  if (opts.openLoop) {
    const olEnd = Math.round(opts.totalMs * 0.65);
    events.push(`Dialogue: 0,${msToAssTime(hookEnd)},${msToAssTime(olEnd)},Hook,,0,0,0,,{\\fs54\\alpha&H30&}${escapeAss(opts.openLoop)}`);
  }
  // Caption theo timestamps
  for (const l of lines) {
    events.push(`Dialogue: 0,${msToAssTime(l.startMs)},${msToAssTime(l.endMs)},Caption,,0,0,0,,${escapeAss(l.text)}`);
  }
  // CTA 2.5s cuối, cũng pop-in
  const ctaStart = Math.max(0, opts.totalMs - 2500);
  events.push(`Dialogue: 0,${msToAssTime(ctaStart)},${msToAssTime(opts.totalMs)},Hook,,0,0,0,,${popIn}${escapeAss(opts.cta)}`);

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    preset.caption,
    preset.hook,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
