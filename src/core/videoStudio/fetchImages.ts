/**
 * Kéo ảnh sản phẩm từ 4Seller cho 1 video:
 *   getListingDetail → images[] → download (cache theo productId)
 *   → sharp cover-crop 1080x1920 (position attention) → remakeImage chống trùng
 * Ảnh gốc cache ở assets/<productId>/src_N.jpg (dùng chung mọi video),
 * ảnh đã xử lý ở assets/<productId>/<videoId>/img_N.jpg (per-video vì seed khác).
 */
import axios from "axios";
import fs from "fs-extra";
import path from "path";
import sharp from "sharp";
import { getListingDetail } from "../../services/fourseller/client";
import { remakeImage } from "../../utils/remakeImage";

const ASSETS_DIR = path.resolve(process.cwd(), "data", "videos", "assets");
const MAX_IMAGES = 8;
const MIN_IMAGES = 3;

/** Bóc URL ảnh từ detail 4Seller (mảng string / mảng object / chuỗi '|'), fallback mainImage của list record. */
export function extractImageUrls(detail: any, mainImage?: string): string[] {
  const urls: string[] = [];
  const push = (v: any) => {
    const u = typeof v === "string" ? v : v?.url ?? v?.imgUrl ?? v?.image ?? "";
    if (u && typeof u === "string") urls.push(u.trim());
  };
  const imgs = detail?.images;
  if (Array.isArray(imgs)) imgs.forEach(push);
  else if (typeof imgs === "string" && imgs) imgs.split("|").forEach(push);
  if (!urls.length && mainImage) mainImage.split("|").forEach(push);
  return [...new Set(urls.filter(Boolean))];
}

async function downloadTo(url: string, file: string): Promise<void> {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" } });
  await fs.writeFile(file, new Uint8Array(Buffer.from(res.data)));
}

export interface FetchImagesResult { files: string[]; dir: string }

export async function fetchImages(opts: {
  principal: string;
  listingId: string;
  productId: string;
  videoId: number;
  seed: string;
  mainImage?: string;
}): Promise<FetchImagesResult> {
  const srcDir = path.join(ASSETS_DIR, opts.productId);
  const outDir = path.join(srcDir, String(opts.videoId));
  await fs.ensureDir(outDir);

  // Ảnh đã xử lý đủ từ lần chạy trước (retry) → tái dùng
  const existing = (await fs.readdir(outDir)).filter((f) => /^img_\d+\.jpg$/.test(f)).sort();
  if (existing.length >= MIN_IMAGES) {
    return { files: existing.map((f) => path.join(outDir, f)), dir: outDir };
  }

  // 1. Lấy URL ảnh (cache src trước, chỉ gọi API khi cache thiếu)
  let srcFiles = (await fs.pathExists(srcDir))
    ? (await fs.readdir(srcDir)).filter((f) => /^src_\d+\.jpg$/.test(f)).sort().map((f) => path.join(srcDir, f))
    : [];
  if (srcFiles.length < MIN_IMAGES) {
    const detail = await getListingDetail(opts.principal, opts.listingId).catch((e) => {
      console.warn(`⚠️ [Images] getListingDetail lỗi: ${e?.message} → thử mainImage`);
      return null;
    });
    const urls = extractImageUrls(detail, opts.mainImage).slice(0, MAX_IMAGES);
    if (urls.length < MIN_IMAGES) throw new Error(`Chỉ tìm thấy ${urls.length} ảnh (cần ≥${MIN_IMAGES})`);
    await fs.ensureDir(srcDir);
    srcFiles = [];
    let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      const f = path.join(srcDir, `src_${i}.jpg`);
      try {
        if (!(await fs.pathExists(f))) await downloadTo(urls[i], f);
        srcFiles.push(f);
      } catch (e: any) {
        failed++;
        console.warn(`⚠️ [Images] Tải ảnh ${i} lỗi: ${e?.message}`);
      }
    }
    if (srcFiles.length < MIN_IMAGES) throw new Error(`Tải được ${srcFiles.length}/${urls.length} ảnh (lỗi ${failed}), cần ≥${MIN_IMAGES}`);
  }

  // 2. Cover-crop 1080x1920 + remake chống trùng (seed per-video per-ảnh)
  const files: string[] = [];
  for (let i = 0; i < Math.min(srcFiles.length, MAX_IMAGES); i++) {
    const tmp = path.join(outDir, `tmp_${i}.jpg`);
    const out = path.join(outDir, `img_${i}.jpg`);
    await sharp(srcFiles[i])
      .resize({ width: 1080, height: 1920, fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 92 })
      .toFile(tmp);
    await remakeImage(tmp, out, { preset: "standard", seed: `${opts.seed}:${i}` });
    await fs.remove(tmp);
    files.push(out);
  }
  return { files, dir: outDir };
}
