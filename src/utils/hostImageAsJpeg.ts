/**
 * Tải ảnh từ URL ngoài → chuyển sang JPEG → host lại → trả URL public.
 *
 * Vì sao cần: ảnh SHEIN đều là `.webp`. Ảnh gallery không sao vì được TẢI VỀ FILE rồi
 * đẩy lên 4Seller qua ô upload. Nhưng ảnh trong MÔ TẢ thì trước đây dán thẳng URL gốc
 * của SHEIN vào CKEditor, và TikTok từ chối:
 *
 *   [Publish Failed] Description image format is incorrect,
 *                    please detection image in the description module
 *
 * Nên ảnh mô tả phải đi đúng đường mà size-guide và trust-banner đang đi: dựng ra file
 * ảnh thường rồi host lên R2/imgbb, chèn URL đó.
 *
 * Có cache theo md5 nội dung (uploadToImgbbCached) — cùng một ảnh SHEIN dùng lại ở listing
 * hay shop khác sẽ không tốn lượt upload mới. Với luồng clone 1 sản phẩm sang nhiều shop
 * thì gần như lần nào cũng trúng cache.
 */
import axios from "axios";
import crypto from "crypto";
import fs from "fs-extra";
import os from "os";
import path from "path";
import sharp from "sharp";
import { uploadToImgbbCached } from "./imgbbCache";
import { verifyImageUrl } from "./uploadToImgbb";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Chất lượng JPEG đầu ra — đủ nét cho ảnh mô tả mà file không phình. */
const JPEG_QUALITY = 88;

/** Ảnh mô tả không cần to hơn mức này; hạ xuống cho nhẹ và upload nhanh. */
const MAX_EDGE = 1200;

/** URL đã là ảnh thường (không phải webp) thì khỏi đụng vào. */
const isAlreadySafe = (url: string): boolean => /\.(jpe?g|png)(\?|$)/i.test(url);

/**
 * Host 1 ảnh. Trả null nếu tải/chuyển/upload hỏng — caller nên BỎ ảnh đó, đừng rơi về
 * URL gốc, vì rơi về webp là quay lại đúng lỗi publish ban đầu.
 */
export async function hostImageAsJpeg(url: string): Promise<string | null> {
  if (!url) return null;

  const tmpDir = path.join(os.tmpdir(), "shein-desc-img");
  const stem = crypto.createHash("md5").update(url).digest("hex");
  const outPath = path.join(tmpDir, `${stem}.jpg`);

  try {
    await fs.ensureDir(tmpDir);
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30_000,
      headers: { "User-Agent": UA },
    });

    // failOn:"none" — ảnh CDN thỉnh thoảng thiếu byte cuối, vẫn decode được phần dùng được.
    await sharp(Buffer.from(res.data), { failOn: "none" })
      .rotate() // tôn trọng EXIF, tránh ảnh nằm ngang
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(outPath);

    const hosted = await uploadToImgbbCached(outPath);
    if (!hosted) {
      console.warn(`⚠️ ảnh mô tả: host thất bại → bỏ ảnh (${url})`);
      return null;
    }
    if (!(await verifyImageUrl(hosted))) {
      console.warn(`⚠️ ảnh mô tả: URL không serve được → bỏ ảnh (${hosted})`);
      return null;
    }
    return hosted;
  } catch (e: any) {
    console.warn(`⚠️ ảnh mô tả: lỗi xử lý (${e?.message ?? e}) → bỏ ảnh (${url})`);
    return null;
  } finally {
    try { await fs.remove(outPath); } catch { /* best-effort */ }
  }
}

/**
 * Host cả loạt ảnh, giữ nguyên thứ tự, bỏ những ảnh hỏng.
 *
 * Tải và chuyển đổi chạy song song; riêng bước upload tự nối đuôi nhau bên trong
 * uploadToImgbb (giãn nhịp tránh rate-limit) nên không cần tự chặn ở đây.
 */
export async function hostImagesAsJpeg(urls: string[]): Promise<string[]> {
  if (!urls?.length) return [];
  const out = await Promise.all(
    urls.map((u) => (isAlreadySafe(u) ? Promise.resolve(u) : hostImageAsJpeg(u)))
  );
  const kept = out.filter((u): u is string => Boolean(u));
  if (kept.length < urls.length) {
    console.warn(`⚠️ ảnh mô tả: giữ ${kept.length}/${urls.length} ảnh (số còn lại host không được)`);
  }
  return kept;
}
