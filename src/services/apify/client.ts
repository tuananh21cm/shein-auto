/**
 * Apify client — chạy actor qua API chính thức (không anti-bot phía mình, Apify lo).
 *
 * Pattern: POST /v2/acts/{actorId}/runs → poll /v2/actor-runs/{runId} tới khi
 * SUCCEEDED → GET /v2/datasets/{datasetId}/items. Actor id dùng dấu `~`
 * (vd "jungle_synthesizer~shein-new-arrivals-bestsellers-trend-scraper").
 *
 * Token: env APIFY_TOKEN ưu tiên, fallback config/apify.json field token.
 * Docs: https://docs.apify.com/api/v2
 */
import { apifyConfig } from "../../config/appConfig";

const API_BASE = "https://api.apify.com/v2";

export function apifyToken(): string {
  return (process.env.APIFY_TOKEN ?? apifyConfig().token ?? "").trim();
}

async function apifyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = apifyToken();
  if (!token) throw new Error("APIFY_TOKEN chưa cấu hình (env hoặc config/apify.json)");
  const res = await fetch(`${API_BASE}${path}${path.includes("?") ? "&" : "?"}token=${token}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b: any = await res.json(); msg = b?.error?.message || msg; } catch { /* ignore */ }
    throw new Error(`Apify ${path.split("?")[0]} → ${msg}`);
  }
  return (await res.json()) as T;
}

export interface ApifyRunInfo {
  id: string;
  status: string; // READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT
  defaultDatasetId: string;
}

/**
 * Chạy actor + chờ xong + trả dataset items. Poll 10s/lần tới timeoutMinutes
 * (mặc định 20). Actor fail/timeout → throw với status rõ ràng.
 */
export async function runActorAndGetItems<T = Record<string, unknown>>(
  actorId: string,
  input: Record<string, unknown>,
  opts: { timeoutMinutes?: number; onLog?: (m: string) => void } = {}
): Promise<T[]> {
  const log = opts.onLog ?? (() => {});
  const timeoutMs = Math.max(1, opts.timeoutMinutes ?? 20) * 60_000;

  log(`Apify: start actor ${actorId}…`);
  const started = await apifyFetch<{ data: ApifyRunInfo }>(
    `/acts/${encodeURIComponent(actorId)}/runs`,
    { method: "POST", body: JSON.stringify(input) }
  );
  const runId = started.data.id;

  const t0 = Date.now();
  let run = started.data;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10_000));
    run = (await apifyFetch<{ data: ApifyRunInfo }>(`/actor-runs/${runId}`)).data;
    if (run.status === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
      throw new Error(`Apify run ${runId} kết thúc ${run.status}`);
    }
  }
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify run ${runId} chưa xong sau ${Math.round(timeoutMs / 60000)}p (status ${run.status})`);
  }
  log(`Apify: run ${runId} SUCCEEDED sau ${Math.round((Date.now() - t0) / 1000)}s — đọc dataset…`);

  // Dataset phân trang 1000/lần — kéo hết (trần 50k phòng runaway).
  const items: T[] = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const page = await apifyFetch<T[]>(
      `/datasets/${run.defaultDatasetId}/items?format=json&clean=true&offset=${offset}&limit=1000`
    );
    items.push(...page);
    if (page.length < 1000) break;
  }
  log(`Apify: ${items.length} items.`);
  return items;
}
