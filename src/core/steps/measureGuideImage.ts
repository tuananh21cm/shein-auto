import axios from "axios";
import sharp from "sharp";

/**
 * Tải ảnh sơ đồ "How to Measure" của SHEIN → che watermark "SHEIN" ở góc dưới-phải
 * bằng hộp trắng (vùng đó là lề trắng nên che vào blend liền, không đụng hình vẽ) →
 * trả về data URI base64 để nhúng thẳng vào mô tả listing (không cần host ảnh).
 *
 * Trả null nếu không có url / tải lỗi → mô tả sẽ bỏ ảnh, giữ phần text.
 */
export async function processMeasureGuideImage(url?: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const buf = Buffer.from(resp.data);
    const img = sharp(buf);
    const meta = await img.metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;

    // Watermark "SHEIN" luôn nằm ở GÓC PHẢI-DƯỚI sâu, nhưng chiều cao thay đổi theo sơ đồ
    // (có sơ đồ sát đáy, có sơ đồ ở ~85%). Sơ đồ vẽ luôn căn giữa-trái nên vùng phải-dưới
    // sâu chỉ còn chữ SHEIN → dò pixel chữ ĐEN ở vùng đó, tính bbox rồi phủ trắng đúng chỗ.
    // Không thấy chữ → trả ảnh gốc (không có watermark vùng này, khỏi che).
    const { data, info } = await sharp(buf)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels; // 3 sau removeAlpha
    const x0 = Math.floor(W * 0.58); // chừa hình vẽ căn giữa-trái
    const y0 = Math.floor(H * 0.72); // chừa marker/viền trên của sơ đồ
    let minX = W, minY = H, maxX = 0, maxY = 0, found = 0;
    for (let y = y0; y < H; y++) {
      for (let x = x0; x < W; x++) {
        const i = (y * W + x) * ch;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 110) {
          found++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (found < 20) {
      // không phát hiện watermark vùng phải-dưới → giữ nguyên ảnh
      return `data:image/png;base64,${buf.toString("base64")}`;
    }
    const pad = Math.round(W * 0.015);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(W - 1, maxX + pad);
    maxY = Math.min(H - 1, maxY + pad);
    const cover = await sharp({
      create: {
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();

    const out = await img
      .composite([{ input: cover, left: minX, top: minY }])
      .png()
      .toBuffer();

    return `data:image/png;base64,${out.toString("base64")}`;
  } catch (e: any) {
    console.warn("⚠️ processMeasureGuideImage lỗi, bỏ ảnh sơ đồ:", e?.message);
    return null;
  }
}
