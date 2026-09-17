import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { uploadToImgbb } from "./uploadToImgbb";
import { workerConfig } from "../config/appConfig";

/**
 * Ảnh SHEIN trả về là .webp. Một số shop TikTok TỪ CHỐI format này trong MÔ TẢ
 * (ảnh main không dính vì đường COS đã convert sẵn — xem listing4sellerApi.uploadImageOnce).
 * → tải về, convert JPEG, host lại (R2 trước, imgbb fallback) rồi trả URL mới.
 *
 * Ảnh vốn đã jpeg/png giữ nguyên URL gốc (khỏi tốn upload). Mọi lỗi cũng trả URL gốc:
 * mô tả mất ảnh còn tệ hơn ảnh sai format.
 */
export async function hostAsJpeg(url: string): Promise<string> {
  if (!/^https?:/i.test(url)) return url;
  let tmp = "";
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return url;
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (ct === "image/jpeg" || ct === "image/png") return url;
    const sharp = (await import("sharp")).default;
    const buf = await sharp(Buffer.from(await r.arrayBuffer())).jpeg({ quality: 88 }).toBuffer();
    tmp = path.join(os.tmpdir(), `descimg_${crypto.randomBytes(6).toString("hex")}.jpg`);
    fs.writeFileSync(tmp, buf);
    return (await uploadToImgbb(tmp)) || url;
  } catch {
    return url;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

/**
 * Trần TỔNG toàn tiến trình cho convert+host ảnh mô tả. Không có nó thì mức song song là
 * par × số listing chạy cùng lúc (concurrency 12 → 48 lượt tải + sharp đồng thời) — sharp là
 * CPU-bound nên đây là chỗ duy nhất trong luồng không bị ghìm bởi trần nào.
 */
const jpegLimit = () => Math.max(4, Math.min(16, (workerConfig().concurrency || 1) * 2));
let jActive = 0;
const jQueue: (() => void)[] = [];
const jAcquire = async () => {
  if (jActive >= jpegLimit()) await new Promise<void>((r) => jQueue.push(r));
  jActive++;
};
const jRelease = () => {
  jActive--;
  jQueue.shift()?.();
};

/** Convert + host cả list, giới hạn song song (ảnh mô tả mặc định 8 cái/listing). */
export async function hostAllAsJpeg(urls: string[], par = 4): Promise<string[]> {
  const out: string[] = new Array(urls.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(par, urls.length) }, async () => {
      while (i < urls.length) {
        const k = i++;
        await jAcquire();
        try { out[k] = await hostAsJpeg(urls[k]); } finally { jRelease(); }
      }
    })
  );
  return out;
}
