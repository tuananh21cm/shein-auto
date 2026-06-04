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

    // Hộp trắng che góc dưới-phải (nơi chữ SHEIN). Tỉ lệ theo kích thước ảnh.
    const boxW = Math.round(W * 0.42);
    const boxH = Math.round(H * 0.07);
    const cover = await sharp({
      create: { width: boxW, height: boxH, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();

    const out = await img
      .composite([{ input: cover, left: W - boxW, top: H - boxH }])
      .png()
      .toBuffer();

    return `data:image/png;base64,${out.toString("base64")}`;
  } catch (e: any) {
    console.warn("⚠️ processMeasureGuideImage lỗi, bỏ ảnh sơ đồ:", e?.message);
    return null;
  }
}
