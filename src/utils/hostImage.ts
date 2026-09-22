import crypto from "crypto";
import fs from "fs";
import axios from "axios";
import { uploadToR2, r2Configured } from "./uploadToR2";

/**
 * Host ảnh cho mô tả listing (URL public) — Cloudflare R2, không rate limit.
 * Trước đây có imgbb làm dự phòng; bỏ 22/09/2026: lần cuối imgbb được dùng là 17 ngày trước,
 * R2 chưa lỗi lần nào. R2 lỗi → trả null → caller bỏ slot ảnh đó (listing vẫn đăng bình thường).
 */
export const imageHostReady = (): boolean => r2Configured();

// R2 đặt key theo md5 nội dung → cùng ảnh luôn ra cùng URL. Nhớ trong tiến trình để khỏi upload lại
// ảnh lặp (vd trust banner giống hệt ở mọi listing).
const memo = new Map<string, string>();

export async function hostImage(filePath: string): Promise<string | null> {
  let md5: string;
  try { md5 = crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex"); }
  catch { return null; }
  const hit = memo.get(md5);
  if (hit) return hit;
  const url = await uploadToR2(filePath).catch(() => null);
  if (url) memo.set(md5, url);
  return url;
}

/**
 * URL ảnh thật sự serve được chưa (content-type image). CDN cần vài giây propagate ảnh mới →
 * retry giãn nhịp; GET Range bytes=0-0 (edge phục vụ GET trước HEAD) + UA browser.
 * URL chết mà vẫn chèn vào mô tả sẽ hiện thành khoảng trống.
 */
export async function verifyImageUrl(url: string): Promise<boolean> {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  for (const wait of [0, 1500, 3000, 5000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": UA, Range: "bytes=0-0" },
        timeout: 8000,
        responseType: "arraybuffer",
        validateStatus: (s) => s === 200 || s === 206,
      });
      if (/^image\//i.test(String(res.headers["content-type"] || ""))) return true;
    } catch { /* chưa propagate / edge-miss → thử lại */ }
  }
  return false;
}
