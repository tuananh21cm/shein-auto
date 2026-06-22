import crypto from "crypto";
import path from "path";
import fs from "fs-extra";
import { uploadToImgbb } from "./uploadToImgbb";

const CACHE_FILE = path.resolve(process.cwd(), "data", "_imgbb_cache.json");

/**
 * Upload ảnh lên imgbb CÓ CACHE theo md5 nội dung → file giống nhau (vd ảnh material POD
 * dùng lại mọi listing) chỉ upload 1 LẦN, các lần sau trả URL cũ → tránh đụng giới hạn imgbb.
 *
 * An toàn cho chống-trùng: ảnh cuối đẩy lên 4Seller vẫn được remake unique mỗi listing
 * (cache này chỉ tái dùng URL trung gian, không phải file đăng).
 */
export async function uploadToImgbbCached(filePath: string): Promise<string | null> {
  let hash = "";
  try {
    const buf = await fs.readFile(filePath);
    hash = crypto.createHash("md5").update(new Uint8Array(buf)).digest("hex");
  } catch {
    return uploadToImgbb(filePath); // không đọc được → upload thẳng
  }

  let cache: Record<string, string> = {};
  try {
    cache = await fs.readJson(CACHE_FILE);
  } catch {
    /* chưa có cache */
  }
  if (cache[hash]) {
    console.log(`💾 [imgbb cache] hit ${path.basename(filePath)}`);
    return cache[hash];
  }

  const url = await uploadToImgbb(filePath);
  if (url) {
    cache[hash] = url;
    try {
      await fs.writeJson(CACHE_FILE, cache);
    } catch {
      /* ghi cache lỗi → bỏ qua, lần sau upload lại */
    }
  }
  return url;
}
