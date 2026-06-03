/**
 * HTTP client cho Kiki anti-detect browser (local API).
 * Port từ dự án zeroti_MKT/backend/src/kiki/client.ts.
 *
 * Endpoints:
 *   POST /api/local-api/profile/start  { profileId } → { websocketDebuggerUrl, debuggingPort, ... }
 *   POST /api/local-api/profile/stop   { profileId }
 */
import axios, { AxiosInstance } from "axios";
import { kikiApiBase } from "./config";

export interface KikiStartResult {
  websocketDebuggerUrl: string;
  debuggingPort: number;
  browserType?: string;
  browserPid?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class KikiClient {
  private _http: AxiosInstance | null = null;

  private http(): AxiosInstance {
    // Lazy + re-read base mỗi lần (config có thể đổi runtime)
    const base = kikiApiBase();
    if (!this._http || (this._http.defaults.baseURL ?? "") !== base) {
      this._http = axios.create({ baseURL: base, timeout: 60_000 });
    }
    return this._http;
  }

  /** Start profile → trả CDP websocket URL. */
  async startProfile(profileId: string): Promise<KikiStartResult> {
    const { data } = await this.http().post("/api/local-api/profile/start", { profileId });
    if (!data?.success) {
      const reason = data?.reason ?? JSON.stringify(data);
      throw new Error(`Kiki start failed: ${reason}`);
    }
    return data.data as KikiStartResult;
  }

  async stopProfile(profileId: string): Promise<void> {
    try {
      await this.http().post("/api/local-api/profile/stop", { profileId });
    } catch {
      /* stop best-effort */
    }
  }

  /** Stop 2 lần để chắc chắn profile được giải phóng. */
  async forceStop(profileId: string): Promise<void> {
    await this.stopProfile(profileId);
    await sleep(800);
    await this.stopProfile(profileId);
  }

  /**
   * Start với retry khi profile đang bận ("SOME_PROGRAM" / busy).
   */
  async startWithRetry(
    profileId: string,
    onLog?: (m: string) => void,
    maxAttempts = 5
  ): Promise<KikiStartResult> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await this.startProfile(profileId);
        onLog?.(`Kiki profile started (attempt ${attempt})`);
        return r;
      } catch (e: any) {
        lastErr = e;
        const busy = /SOME_PROGRAM|busy|already/i.test(e?.message ?? "");
        if (busy && attempt < maxAttempts) {
          onLog?.(`Profile bận, chờ rồi thử lại (${attempt}/${maxAttempts})…`);
          await this.stopProfile(profileId);
          await sleep(2500);
        } else if (attempt < maxAttempts) {
          await sleep(1500);
        } else {
          break;
        }
      }
    }
    throw new Error(`Kiki không start được profile ${profileId}: ${lastErr?.message ?? "unknown"}`);
  }

  async ping(): Promise<boolean> {
    try {
      await this.http().get("/", { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export const kiki = new KikiClient();
