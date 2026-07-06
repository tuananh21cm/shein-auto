/**
 * "Remake" ảnh trước khi upload lên 4Seller để 10 shop dùng chung 1 nguồn ảnh
 * SHEIN không bị TikTok phát hiện trùng (exact-hash + perceptual-hash dedup).
 *
 * Kỹ thuật (preset "standard"): strip metadata + re-encode + micro-crop +
 * xoay nhẹ + jitter màu (brightness/saturation/hue/contrast) + noise mờ.
 * Mỗi shop seed bằng tên shop → ra ảnh KHÁC NHAU nhưng CỐ ĐỊNH (re-run không churn).
 *
 * Tất cả biến đổi đều subtle để buyer không thấy ảnh "lỗi".
 */
import sharp from "sharp";

export type RemakePreset = "light" | "standard" | "aggressive";

export interface RemakeOptions {
  preset?: RemakePreset;
  /** Chuỗi seed (vd `${shopFolder}:${index}`). Rỗng = ngẫu nhiên mỗi lần. */
  seed?: string;
  /** Lật ngang ảnh (mirror). Mặc định false — phá chữ/logo. */
  flip?: boolean;
}

/** PRNG xác định từ chuỗi seed (mulberry32 + xfnv1a hash). */
function seededRng(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PresetParams {
  cropMin: number; // tỷ lệ crop mỗi chiều (0.03 = bỏ 3%)
  cropMax: number;
  rotateMax: number; // độ
  brightness: number; // biên ±
  saturation: number;
  hue: number; // độ ±
  contrast: number;
  qualityMin: number;
  qualityMax: number;
  noiseAlpha: number; // 0-255, 0 = không noise
  border: number; // tỷ lệ viền thêm (aggressive)
}

const PRESETS: Record<RemakePreset, PresetParams> = {
  light: {
    cropMin: 0, cropMax: 0, rotateMax: 0,
    brightness: 0.02, saturation: 0.03, hue: 2, contrast: 0.02,
    qualityMin: 88, qualityMax: 95, noiseAlpha: 0, border: 0,
  },
  standard: {
    cropMin: 0.02, cropMax: 0.045, rotateMax: 1.2,
    brightness: 0.03, saturation: 0.04, hue: 3, contrast: 0.03,
    // noise=0: noise tile 64px nearest gây sạn/vón trên nền gradient (trời) → bỏ.
    // quality 90-96: tránh banding vùng mượt. Dedup pHash vẫn mạnh nhờ crop+rotate+jitter màu.
    qualityMin: 90, qualityMax: 96, noiseAlpha: 0, border: 0,
  },
  aggressive: {
    cropMin: 0.04, cropMax: 0.08, rotateMax: 1.8,
    brightness: 0.05, saturation: 0.06, hue: 5, contrast: 0.05,
    qualityMin: 80, qualityMax: 92, noiseAlpha: 10, border: 0.02,
  },
};

/** Tạo lớp noise nhỏ (seeded) rồi để sharp phóng to → vân mờ xác định. */
function buildNoiseTile(rng: () => number, size: number, alpha: number): Buffer {
  const buf = Buffer.allocUnsafe(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.floor(rng() * 256);
    buf[i * 4] = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v;
    buf[i * 4 + 3] = alpha;
  }
  return buf;
}

/**
 * Remake 1 ảnh. Nếu lỗi (ảnh hỏng…) → throw để caller fallback dùng ảnh gốc.
 */
export async function remakeImage(
  inputPath: string,
  outputPath: string,
  opts: RemakeOptions = {}
): Promise<void> {
  const preset = opts.preset ?? "standard";
  const p = PRESETS[preset];
  const rng = opts.seed ? seededRng(opts.seed) : Math.random;
  const pick = (min: number, max: number) => min + rng() * (max - min);
  const signed = (mag: number) => (rng() * 2 - 1) * mag;

  const src = sharp(inputPath, { failOn: "none" }).rotate(); // auto-orient theo EXIF
  const meta = await src.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("Không đọc được kích thước ảnh");

  // Tham số biến đổi (seeded)
  const cropFrac = pick(p.cropMin, p.cropMax);
  const angle = signed(p.rotateMax);
  const brightness = 1 + signed(p.brightness);
  const saturation = 1 + signed(p.saturation);
  const hue = Math.round(signed(p.hue));
  const contrast = 1 + signed(p.contrast);
  const quality = Math.round(pick(p.qualityMin, p.qualityMax));

  // Kích thước đích sau crop (giữ tỷ lệ gốc, chỉ nhỏ đi cropFrac)
  const targetW = Math.max(8, Math.round(W * (1 - cropFrac)));
  const targetH = Math.max(8, Math.round(H * (1 - cropFrac)));

  // Pass 1: hình học + màu. Rotate nhẹ (thêm viền) → resize cover/centre để cắt
  // bỏ viền xoay đồng thời micro-crop. Sau đó modulate + contrast.
  let pipeline = src
    .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .resize(targetW, targetH, { fit: "cover", position: "centre" })
    .modulate({ brightness, saturation, hue })
    .linear(contrast, 128 * (1 - contrast));

  if (opts.flip) pipeline = pipeline.flop();

  // Viền (aggressive)
  if (p.border > 0) {
    const bx = Math.round(targetW * p.border);
    const by = Math.round(targetH * p.border);
    pipeline = pipeline.extend({
      top: by, bottom: by, left: bx, right: bx,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }

  let buf = await pipeline.toBuffer();

  // Pass 2: noise mờ (nếu preset có) → composite lên ảnh đã xử lý
  if (p.noiseAlpha > 0) {
    const m2 = await sharp(buf).metadata();
    const fw = m2.width ?? targetW;
    const fh = m2.height ?? targetH;
    const tile = buildNoiseTile(rng, 64, p.noiseAlpha);
    const noiseFull = await sharp(tile, { raw: { width: 64, height: 64, channels: 4 } })
      .resize(fw, fh, { kernel: "nearest" })
      .png()
      .toBuffer();
    buf = await sharp(buf)
      .composite([{ input: noiseFull, blend: "over" }])
      .toBuffer();
  }

  // Ghi ra JPEG (mozjpeg) — metadata bị strip mặc định (không withMetadata)
  await sharp(buf).jpeg({ quality, mozjpeg: true }).toFile(outputPath);
}
