/**
 * Gen video từ ảnh sản phẩm HUB qua render server LAN (autoshein).
 * Luồng: đọc title + product_images từ file Hub → submitVideoJob → poll tới ready →
 * tải mp4 về data/videos/hub → cập nhật videoDb. KHÔNG render local (offload sang server).
 * Nguồn ảnh là URL http nên KHÔNG cần 4Seller/getListingDetail.
 */
import fs from "fs-extra";
import path from "path";
import { config } from "../../config";
import { VideoDb } from "../../state/videoDb";
import { submitVideoJob, getVideoJob, downloadVideoJob, type SubmitJobInput } from "../../services/autoshein/client";

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
      const input: SubmitJobInput = { title, images, price: priceOf(d) };
      let jobId: string;
      try {
        const ref = await submitVideoJob(input);
        jobId = ref.jobId;
      } catch (e: any) {
        skipped.push({ file, reason: `submit lỗi: ${String(e?.message ?? e).slice(0, 120)}` });
        continue;
      }
      const id = db.create({ shop: "hub", productId: productIdOf(d) || file, listingId: "", title, seed: jobId });
      db.setStatus(id, { status: "generating", step: "remote" });
      db.setJobId(id, jobId);
      void trackJob(id, jobId);
      created.push({ id, file, title });
    }
  } finally {
    db.close();
  }
  return { created, skipped };
}

/** Sau restart: nối lại poll cho các job Hub còn dở (generating + job_id). */
export function resumePendingHubJobs(): void {
  try {
    const db = new VideoDb();
    const rows = db.pendingRemote().filter((r) => r.shop === "hub");
    db.close();
    for (const r of rows) if (r.job_id) void trackJob(r.id, r.job_id);
    if (rows.length) console.log(`🎬 Resume ${rows.length} job video Hub đang render…`);
  } catch { /* best-effort */ }
}
