/**
 * Gen video từ ảnh sản phẩm HUB — RENDER LOCAL từ 29/09 (enqueueVideo → videoQueue). Phần poll job
 * server LAN (trackJob/resumePendingHubJobs) chỉ còn để nhận nốt job cũ đã gửi đi trước đó.
 * Luồng: đọc title + product_images từ file Hub → submitVideoJob → poll tới ready →
 * tải mp4 về data/videos/hub → cập nhật videoDb. KHÔNG render local (offload sang server).
 * Nguồn ảnh là URL http nên KHÔNG cần 4Seller/getListingDetail.
 */
import fs from "fs-extra";
import path from "path";
import { config } from "../../config";
import { VideoDb } from "../../state/videoDb";
import { submitVideoJob, getVideoJob, downloadVideoJob, type SubmitJobInput } from "../../services/autoshein/client";
import { videoQueue } from "./videoQueue";
import { resolveImage } from "./externalJob";
import { resolveAccountForShop } from "../../state/fourSellerAccounts";

const OUT_DIR = path.join(process.cwd(), "data", "videos", "hub");
const MIN_IMAGES = 3;
const MAX_IMAGES = 8;
const POLL_MS = 5000;
const TIMEOUT_MS = 8 * 60_000;

const https = (u: string): string =>
  u.startsWith("//") ? "https:" + u : u.replace(/^http:\/\//, "https://");

/** Gom URL ảnh từ 1 sản phẩm Hub: product_images trước, thiếu thì trải variant_images. */
export function hubImageUrls(d: any): string[] {
  const out: string[] = [];
  const push = (u: any) => { if (typeof u === "string" && /^https?:|^\/\//.test(u.trim())) out.push(https(u.trim())); };
  if (Array.isArray(d?.product_images)) d.product_images.forEach(push);
  if (out.length < MIN_IMAGES && Array.isArray(d?.variant_images)) {
    for (const o of d.variant_images) {
      const arr = o && typeof o === "object" ? Object.values(o)[0] : null;
      if (Array.isArray(arr)) arr.forEach(push);
    }
  }
  return [...new Set(out)].slice(0, MAX_IMAGES);
}

const productIdOf = (d: any): string => {
  const m = String(d?.url || "").match(/-p-(\d+)\.html/);
  return m ? m[1] : "";
};

const priceOf = (d: any): number | undefined => {
  const arr = Array.isArray(d?.variant_price) ? d.variant_price : [];
  for (const it of arr) for (const v of Object.values(it || {})) {
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
};

/** Poll 1 job tới ready → tải mp4 → cập nhật DB. Fire-and-forget (tự bắt lỗi). */
async function trackJob(id: number, jobId: string): Promise<void> {
  const db = new VideoDb();
  const t0 = Date.now();
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timeout ${Math.round(TIMEOUT_MS / 1000)}s`);
      const st = await getVideoJob(jobId).catch((e) => ({ status: "poll-error", ready: false, error: e?.message } as any));
      if (st.error || /fail|error/i.test(st.status)) {
        if (st.status === "poll-error") continue; // lỗi mạng tạm → thử lại
        throw new Error(st.error || st.status);
      }
      if (st.ready || /ready|done|success|completed/i.test(st.status)) {
        const buf = await downloadVideoJob(jobId);
        await fs.ensureDir(OUT_DIR);
        const file = path.join(OUT_DIR, `hub_${id}.mp4`);
        await fs.writeFile(file, buf);
        // Lưu caption/hashtag/title do render server trả về (để hiện + copy khi đăng).
        if (st.content) { try { db.setScript(id, JSON.stringify(st.content)); } catch { /* ignore */ } }
        db.setStatus(id, { status: "ready", step: "done", file, error: null });
        return;
      }
    }
  } catch (err: any) {
    db.setStatus(id, { status: "error", step: "remote", error: String(err?.message ?? err).slice(0, 300) });
  } finally {
    db.close();
  }
}

export interface CreateHubVideoResult {
  created: { id: number; file: string; title: string }[];
  skipped: { file: string; reason: string }[];
}

/** Số ảnh tối thiểu để gen video (export cho endpoint). */
export const VIDEO_MIN_IMAGES = MIN_IMAGES;
export { priceOf };

/**
 * CORE: từ 1 sản phẩm (đã có ảnh) → submit job render + ghi videoDb + track. Trả videoId.
 * Dùng chung cho Hub lẫn listing theo shop. Throw nếu submit lỗi.
 */
export async function enqueueVideo(
  _db: VideoDb,
  item: { shop: string; productId: string; title: string; images: string[]; price?: number }
): Promise<number> {
  // RENDER LOCAL (29/09): máy render LAN 10.10.10.254 chập chờn → không gửi đi nữa. Ảnh ghi vào
  // assets/<productId>/src_N.jpg (fetchImages dùng cache này, không gọi 4Seller) rồi vào videoQueue
  // local (ffmpeg + Edge TTS, bản render nhánh external-video-api). Shop không có tài khoản 4Seller
  // (hub, ext:…) → "api:<shop>" để videoQueue bỏ bước tra account.
  const dir = path.join(process.cwd(), "data", "videos", "assets", item.productId);
  await fs.ensureDir(dir);
  let n = 0;
  for (let i = 0; i < item.images.length && n < MAX_IMAGES; i++) {
    try { await fs.writeFile(path.join(dir, `src_${n}.jpg`), new Uint8Array(await resolveImage(https(item.images[i]), i))); n++; }
    catch (e: any) { console.warn(`⚠️ [enqueueVideo ${item.productId}] ${e?.message ?? e}`); }
  }
  if (n < MIN_IMAGES) throw new Error(`Chỉ tải được ${n}/${item.images.length} ảnh (cần ≥${MIN_IMAGES})`);
  const shop = (await resolveAccountForShop(item.shop)) ? item.shop : `api:${item.shop}`;
  const [id] = videoQueue.enqueue(shop, [{ productId: item.productId, listingId: item.productId, title: item.title, price: item.price != null ? String(item.price) : undefined }]);
  return id;
}

/** Tạo video cho các file Hub đã chọn. Trả rows đã enqueue + list bị bỏ (thiếu ảnh...). */
export async function createHubVideos(files: string[]): Promise<CreateHubVideoResult> {
  const db = new VideoDb();
  const created: CreateHubVideoResult["created"] = [];
  const skipped: CreateHubVideoResult["skipped"] = [];
  try {
    for (const file of files) {
      if (!file || /[\/\\]|\.\./.test(file)) { skipped.push({ file, reason: "tên file không hợp lệ" }); continue; }
      const full = path.join(config.hubDir, file);
      let d: any;
      try { d = await fs.readJson(full); } catch { skipped.push({ file, reason: "không đọc được file" }); continue; }
      const images = hubImageUrls(d);
      if (images.length < MIN_IMAGES) { skipped.push({ file, reason: `chỉ ${images.length} ảnh, cần ≥${MIN_IMAGES}` }); continue; }
      const title = String(d?.product_name || "").slice(0, 200) || "SHEIN product";
      try {
        const id = await enqueueVideo(db, { shop: "hub", productId: productIdOf(d) || file, title, images, price: priceOf(d) });
        created.push({ id, file, title });
      } catch (e: any) {
        skipped.push({ file, reason: `submit lỗi: ${String(e?.message ?? e).slice(0, 120)}` });
      }
    }
  } finally {
    db.close();
  }
  return { created, skipped };
}

/** Sau restart: nối lại poll cho MỌI job video còn dở (generating + job_id) — Hub lẫn shop. */
export function resumePendingHubJobs(): void {
  try {
    const db = new VideoDb();
    const rows = db.pendingRemote();
    db.close();
    for (const r of rows) if (r.job_id) void trackJob(r.id, r.job_id);
    if (rows.length) console.log(`🎬 Resume ${rows.length} job video đang render…`);
  } catch { /* best-effort */ }
}
