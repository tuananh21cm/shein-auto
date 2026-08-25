/**
 * Client gọi render service "autoshein" (chạy trên server local khác).
 * Contract:
 *   POST /api/video/jobs   Bearer <VIDEO_API_KEY>
 *     body: { title, images[≥3], attributes?, price?, pv?, orders? }   images = base64 data-URL | http URL
 *     → 202 { jobId, videoId, status }
 *   GET  /api/video/jobs/:jobId            → { status, ready, downloadUrl?, error? }
 *   GET  /api/video/jobs/:jobId/download   → file mp4 (1080×1920)
 *
 * Cấu hình .env:  VIDEO_RENDER_URL=http://<ip>:<port>   VIDEO_API_KEY=<key>
 */
const BASE = () => (process.env.VIDEO_RENDER_URL || "").replace(/\/+$/, "");
const KEY = () => process.env.VIDEO_API_KEY || "";

function assertCfg() {
  if (!BASE()) throw new Error("VIDEO_RENDER_URL chưa cấu hình trong .env");
  if (!KEY()) throw new Error("VIDEO_API_KEY chưa cấu hình trong .env");
}

export interface SubmitJobInput {
  title: string;
  images: string[];              // ≥3 · base64 data-URL hoặc http URL
  attributes?: string;
  price?: string | number;
  pv?: number;
  orders?: number;
}
export interface JobRef { jobId: string; videoId?: string; status: string; }
export interface VideoContent { title?: string; caption?: string; description?: string; hashtags?: string[]; }
export interface JobStatus { status: string; ready: boolean; downloadUrl?: string; error?: string; content?: VideoContent; }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  assertCfg();
  const res = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY()}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`autoshein ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text) as T; } catch { return text as any; }
}

/** Đẩy 1 job render. Trả jobId. */
export async function submitVideoJob(input: SubmitJobInput): Promise<JobRef> {
  if (!input.images || input.images.length < 3) throw new Error("cần ≥3 ảnh");
  return req<JobRef>("/api/video/jobs", { method: "POST", body: JSON.stringify(input) });
}

export async function getVideoJob(jobId: string): Promise<JobStatus> {
  return req<JobStatus>(`/api/video/jobs/${encodeURIComponent(jobId)}`);
}

/** Tải mp4 về Buffer. */
export async function downloadVideoJob(jobId: string): Promise<Buffer> {
  assertCfg();
  const res = await fetch(`${BASE()}/api/video/jobs/${encodeURIComponent(jobId)}/download`, {
    headers: { Authorization: `Bearer ${KEY()}` },
  });
  if (!res.ok) throw new Error(`autoshein download → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Submit + poll tới ready (hoặc lỗi/timeout). onLog để stream tiến độ. */
export async function renderAndWait(
  input: SubmitJobInput,
  opts: { pollMs?: number; timeoutMs?: number; onLog?: (m: string) => void } = {}
): Promise<{ jobId: string; status: JobStatus }> {
  const log = opts.onLog ?? (() => {});
  const pollMs = opts.pollMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const ref = await submitVideoJob(input);
  log(`submitted jobId=${ref.jobId} status=${ref.status}`);
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = await getVideoJob(ref.jobId);
    log(`poll: status=${st.status} ready=${st.ready}${st.error ? " err=" + st.error : ""}`);
    if (st.ready || /ready|done|success|completed/i.test(st.status)) return { jobId: ref.jobId, status: st };
    if (st.error || /fail|error/i.test(st.status)) throw new Error(`render lỗi: ${st.error || st.status}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout sau ${Math.round(timeoutMs / 1000)}s (status ${st.status})`);
  }
}
