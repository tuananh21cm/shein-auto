import axios from "axios";
import fs from "fs";
import { config } from "../config";

/**
 * Upload 1 file ảnh lên imgbb → trả URL public (để chèn vào mô tả listing).
 * Cần IMGBB_API_KEY trong .env. Trả null nếu thiếu key / lỗi.
 */
// Giãn nhịp: imgbb free rate-limit khi upload dồn dập → đảm bảo cách nhau tối thiểu.
let _lastUploadAt = 0;
let _keyIdx = 0; // con trỏ xoay vòng key (round-robin để rải tải đều)
const MIN_GAP_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify URL ảnh thật sự sống + trả content-type image (HEAD request).
 * imgbb thi thoảng trả URL nhưng ảnh không serve được → chèn vào mô tả
 * thành khoảng trống. Dùng ngay sau upload để loại URL chết.
 */
export async function verifyImageUrl(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { timeout: 8000 });
    return /^image\//i.test(String(res.headers["content-type"] || ""));
  } catch {
    return false;
  }
}

export async function uploadToImgbb(filePath: string): Promise<string | null> {
  const keys = config.imgbbApiKeys;
  if (!keys.length) {
    console.warn("⚠️ IMGBB_API_KEY(S) chưa set — bỏ qua upload.");
    return null;
  }
  const b64 = fs.readFileSync(filePath).toString("base64");

  // Mỗi "cycle" = thử LẦN LƯỢT tất cả key. Key bị rate-limit → xoay sang key kế NGAY (không chờ).
  // Chỉ khi CẢ các key đều limit trong 1 cycle mới chờ backoff rồi cycle lại (kiên nhẫn).
  const backoffs = [0, 15000, 30000, 60000, 120000, 300000]; // 0,15s,30s,1p,2p,5p
  for (let cycle = 0; cycle < backoffs.length; cycle++) {
    if (backoffs[cycle]) {
      console.warn(`⚠️ imgbb: tất cả ${keys.length} key đều rate-limit — chờ ${backoffs[cycle] / 1000}s rồi thử lại…`);
      await sleep(backoffs[cycle]);
    }
    for (let tried = 0; tried < keys.length; tried++) {
      const idx = _keyIdx % keys.length;
      _keyIdx++; // round-robin: lần sau bắt đầu từ key kế
      const key = keys[idx];
      const since = Date.now() - _lastUploadAt;
      if (since < MIN_GAP_MS) await sleep(MIN_GAP_MS - since);
      _lastUploadAt = Date.now();
      try {
        const form = new URLSearchParams();
        form.append("image", b64);
        const res = await axios.post(`https://api.imgbb.com/1/upload?key=${key}`, form, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 30000,
          maxBodyLength: Infinity,
        });
        const url = res.data?.data?.url || res.data?.data?.display_url || null;
        if (url) console.log(`☁️ imgbb (key #${idx + 1}): ${url}`);
        return url;
      } catch (e: any) {
        const msg = e?.response?.data?.error?.message || e?.message || "";
        if (/rate limit/i.test(msg)) {
          console.warn(`⚠️ imgbb key #${idx + 1} rate-limit → xoay key kế…`);
          continue; // thử key tiếp theo NGAY
        }
        console.warn(`⚠️ imgbb upload lỗi (key #${idx + 1}):`, msg);
        return null; // lỗi khác (ảnh hỏng…) → đổi key cũng vô ích
      }
    }
  }
  return null;
}
