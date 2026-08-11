/**
 * externalJob — "chế độ headless" của Video Studio cho API bên ngoài.
 *
 * Bên thứ ba đẩy ẢNH (base64 data-URL hoặc http URL) + attribute → ta ghi ảnh vào
 * assets/<jobId>/src_N.jpg rồi enqueue video với shop "api:<client>". fetchImages thấy
 * src cache sẵn nên KHÔNG gọi 4Seller (xem fetchImages.ts) — tái dùng nguyên pipeline
 * crop→script→tts→render. jobId (= productId) là handle để bên ngoài poll status + tải video.
 */
import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { videoQueue } from "./videoQueue";

const ASSETS_DIR = path.resolve(process.cwd(), "data", "videos", "assets");
const MIN_IMAGES = 3; // khớp fetchImages.ts
const MAX_IMAGES = 8;
const MAX_IMG_BYTES = 12 * 1024 * 1024; // 12MB/ảnh

const EXT_RE = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i;

/** Lấy Buffer ảnh từ 1 phần tử images[] (base64 data-URL hoặc http URL). */
async function resolveImage(src: string, idx: number): Promise<Buffer> {
  const s = (src ?? "").trim();
  if (!s) throw new Error(`Ảnh #${idx} rỗng`);
  const m = s.match(EXT_RE);
  if (m) {
    const buf = Buffer.from(m[2], "base64");
    if (buf.length === 0) throw new Error(`Ảnh #${idx} base64 sai/rỗng`);
    if (buf.length > MAX_IMG_BYTES) throw new Error(`Ảnh #${idx} quá lớn (>12MB)`);
    return buf;
  }
  if (/^https?:\/\//i.test(s)) {
    const res = await axios.get(s, {
      responseType: "arraybuffer", timeout: 30_000, maxContentLength: MAX_IMG_BYTES,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const buf = Buffer.from(res.data);
    if (buf.length === 0) throw new Error(`Ảnh #${idx} tải về rỗng`);
    return buf;
  }
  throw new Error(`Ảnh #${idx} không hợp lệ (cần base64 data-URL hoặc http URL)`);
}

export interface ExternalJobInput {
  client: string;          // tên client (để phân biệt trong shop "api:<client>")
  title: string;
  images: string[];        // base64 data-URL hoặc http URL, ≥3
  attributes?: string;
  price?: string;
  pv?: number;
  orders?: number;
}

export interface ExternalJobResult { jobId: string; videoId: number }

/** Tạo 1 job render video từ input NGOÀI. Trả jobId (= productId) + videoId. */
export async function createExternalVideoJob(input: ExternalJobInput): Promise<ExternalJobResult> {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Thiếu title");
  const imgs = Array.isArray(input.images) ? input.images.filter(Boolean) : [];
  if (imgs.length < MIN_IMAGES) throw new Error(`Cần ≥${MIN_IMAGES} ảnh (nhận ${imgs.length})`);
  const client = (input.client || "ext").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "ext";

  const jobId = crypto.randomBytes(12).toString("hex");
  const srcDir = path.join(ASSETS_DIR, jobId);
  await fs.ensureDir(srcDir);

  // Ghi ảnh vào src_N.jpg (fetchImages sẽ crop 1080x1920 + remake). Chỉ nhận tối đa MAX_IMAGES.
  let n = 0;
  for (let i = 0; i < imgs.length && n < MAX_IMAGES; i++) {
    try {
      const buf = await resolveImage(imgs[i], i);
      await fs.writeFile(path.join(srcDir, `src_${n}.jpg`), new Uint8Array(buf));
      n++;
    } catch (e: any) {
      console.warn(`⚠️ [ExternalJob ${jobId}] ${e?.message ?? e}`);
    }
  }
  if (n < MIN_IMAGES) {
    await fs.remove(srcDir).catch(() => {});
    throw new Error(`Chỉ xử lý được ${n}/${imgs.length} ảnh (cần ≥${MIN_IMAGES})`);
  }

  // productId = listingId = jobId; shop "api:<client>" → process() bypass account 4Seller.
  const [videoId] = videoQueue.enqueue(`api:${client}`, [{
    productId: jobId, listingId: jobId, title,
    attributes: input.attributes, price: input.price, pv: input.pv, orders: input.orders,
  }]);
  return { jobId, videoId };
}
