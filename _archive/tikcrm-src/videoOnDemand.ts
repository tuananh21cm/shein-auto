/**
 * Làm video theo yêu cầu từ report (backend cho nút "🎬 Làm video").
 * Luồng: request → lấy ảnh SP (4Seller) → submit autoshein → poll → download.
 * State lưu per-shop (data/tikcrm/video_jobs/<code>.json) để report re-hydrate qua reload.
 */
import fs from "fs-extra";
import path from "path";
import { getShopFourSeller, dayKey } from "./dailyStore";
import { getListings } from "./listingsStore";
import { getListingPage, getListingDetail } from "../fourseller/client";
import { extractImageUrls } from "../../core/videoStudio/fetchImages";
import { submitVideoJob, getVideoJob, downloadVideoJob } from "../autoshein/client";

const JOBS_DIR = path.resolve(process.cwd(), "data", "tikcrm", "video_jobs");
const FILES_DIR = path.resolve(process.cwd(), "data", "tikcrm", "video_files");
const DAILY_CAP = 20;

export interface VideoJob {
  product_id: string; title: string; job_id: string;
  status: string; ready: boolean; error?: string; at: string; day: string; file?: string;
  content?: { title?: string; caption?: string; description?: string; hashtags?: string[] };
}
type JobMap = Record<string, VideoJob>;

function jobsFile(code: string) { return path.join(JOBS_DIR, code.replace(/[^\w.-]/g, "_") + ".json"); }
function readJobs(code: string): JobMap { try { const f = jobsFile(code); return fs.existsSync(f) ? fs.readJsonSync(f) : {}; } catch { return {}; } }
function writeJobs(code: string, m: JobMap) { fs.ensureDirSync(JOBS_DIR); fs.writeJsonSync(jobsFile(code), m); }

/* ── Index listing 4Seller (productId → listingId/title/mainImage), cache 5′/shop ── */
const idxCache = new Map<string, { at: number; index: Map<string, { listingId: string; title: string; mainImage: string }> }>();
async function listingIndex(code: string): Promise<{ principal: string; index: Map<string, any> } | null> {
  const f4 = getShopFourSeller(code);
  if (!f4) return null;
  const principal = `acct:${f4.uid}`;
  const cached = idxCache.get(code);
  if (cached && Date.now() - cached.at < 5 * 60_000) return { principal, index: cached.index };
  const index = new Map<string, any>();
  for (let page = 1; page <= 20; page++) {
    const res = await getListingPage(principal, { shopId: Number(f4.shopId), status: "active", pageCurrent: page, pageSize: 100 });
    for (const r of res.records ?? []) {
      index.set(String((r as any).productId), { listingId: String(r.id), title: String((r as any).title ?? (r as any).productName ?? ""), mainImage: String((r as any).mainImage ?? "") });
    }
    if ((res.records?.length ?? 0) < 100) break;
  }
  idxCache.set(code, { at: Date.now(), index });
  return { principal, index };
}

/** Ảnh SP để render (≥3). Trả {title, images, stats} hoặc lỗi. */
async function resolveProduct(code: string, productId: string): Promise<{ title: string; images: string[]; pv?: number; orders?: number } | { error: string }> {
  const idx = await listingIndex(code);
  if (!idx) return { error: "Shop chưa map 4Seller — không lấy được ảnh listing." };
  const rec = idx.index.get(String(productId));
  if (!rec) return { error: "Không tìm thấy listing 4Seller cho SP này." };
  let images = extractImageUrls(rec, rec.mainImage).slice(0, 8);
  if (images.length < 3) {
    const detail = await getListingDetail(idx.principal, rec.listingId).catch(() => null);
    images = extractImageUrls(detail, rec.mainImage).slice(0, 8);
  }
  if (images.length < 3) return { error: `Chỉ có ${images.length} ảnh (cần ≥3).` };
  const listing = (getListings(code).listings ?? []).find((l: any) => String(l.product_id) === String(productId)) as any;
  return { title: rec.title || listing?.product_name || "Sản phẩm", images, pv: listing?.pv_28d, orders: listing?.orders_28d };
}

function patchJob(code: string, productId: string, patch: Partial<VideoJob>): void {
  const jobs = readJobs(code); if (!jobs[productId]) return;
  Object.assign(jobs[productId], patch); writeJobs(code, jobs);
}

/** Resolve ảnh + submit autoshein (chạy NỀN, cập nhật job qua store). */
async function resolveAndSubmit(code: string, productId: string): Promise<void> {
  try {
    const p = await resolveProduct(code, productId);
    if ("error" in p) { patchJob(code, productId, { status: "error", error: p.error }); return; }
    const ref = await submitVideoJob({ title: p.title, images: p.images, attributes: p.title, pv: p.pv, orders: p.orders });
    patchJob(code, productId, { title: p.title, job_id: ref.jobId, status: ref.status || "queued" });
  } catch (e: any) { patchJob(code, productId, { status: "error", error: String(e?.message ?? e).slice(0, 200) }); }
}

/** Bấm "Làm video": tạo job ngay (resolving) + resolve/submit chạy nền → trả về liền, không treo UI. */
export async function requestVideo(code: string, productId: string): Promise<VideoJob | { error: string }> {
  const jobs = readJobs(code);
  const cur = jobs[productId];
  if (cur && !cur.ready && !cur.error) return cur; // đang chạy → không submit trùng
  if (!getShopFourSeller(code)) return { error: "Shop chưa map 4Seller — không lấy được ảnh listing." };
  const todayCount = Object.values(jobs).filter((j) => j.day === dayKey()).length;
  if (todayCount >= DAILY_CAP && !cur) return { error: `Đã đạt giới hạn ${DAILY_CAP} video/shop/ngày.` };

  const job: VideoJob = { product_id: productId, title: "Đang lấy ảnh…", job_id: "", status: "resolving", ready: false, at: new Date().toISOString(), day: dayKey() };
  jobs[productId] = job; writeJobs(code, jobs);
  resolveAndSubmit(code, productId); // fire-and-forget
  return job;
}

/** Poll: refresh status các job chưa xong từ autoshein → cập nhật store. Trả toàn bộ state. */
export async function refreshVideoState(code: string): Promise<VideoJob[]> {
  const jobs = readJobs(code);
  let changed = false;
  for (const j of Object.values(jobs)) {
    if (!j.job_id) continue;                          // resolving (chưa có job_id) → tự cập nhật ở nền
    if (j.ready) {                                     // đã xong: backfill content nếu thiếu (job cũ)
      if (!j.content) { try { const st = await getVideoJob(j.job_id); if (st.content) { j.content = st.content; changed = true; } } catch { /* */ } }
      continue;
    }
    if (j.error) continue;
    try {
      const st = await getVideoJob(j.job_id);
      const ready = st.ready || /ready|done|success|completed/i.test(st.status);
      const failed = st.error || /fail|error/i.test(st.status);
      if (ready) { j.ready = true; j.status = "ready"; if (st.content) j.content = st.content; changed = true; }
      else if (failed) { j.error = st.error || st.status; j.status = "error"; changed = true; }
      else if (st.status && st.status !== j.status) { j.status = st.status; changed = true; }
    } catch { /* autoshein tạm lỗi → giữ nguyên, poll sau */ }
  }
  if (changed) writeJobs(code, jobs);
  return Object.values(jobs).sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Tải mp4 (cache local để tải lại nhanh). */
export async function getVideoFile(code: string, productId: string): Promise<{ file: string } | { error: string }> {
  const jobs = readJobs(code);
  const j = jobs[productId];
  if (!j) return { error: "Chưa có video cho SP này." };
  if (!j.ready) return { error: "Video chưa render xong." };
  const local = path.join(FILES_DIR, code.replace(/[^\w.-]/g, "_"), productId + ".mp4");
  if (j.file && fs.existsSync(j.file)) return { file: j.file };
  const buf = await downloadVideoJob(j.job_id);
  fs.ensureDirSync(path.dirname(local));
  fs.writeFileSync(local, buf);
  j.file = local; writeJobs(code, jobs);
  return { file: local };
}
