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

  /**
   * Start profile → trả CDP websocket URL.
   * Kiki trả HTTP 500 kèm body {reason} khi profile bận (SOME_PROGRAM_IS_USING_THIS_PROFILE)
   * → validateStatus nới ra để ĐỌC ĐƯỢC reason, nếu không message chỉ là "status code 500"
   * và startWithRetry không nhận ra là "bận" để force-stop rồi thử lại.
   */
  async startProfile(profileId: string): Promise<KikiStartResult> {
    const { data } = await this.http().post(
      "/api/local-api/profile/start",
      { profileId },
      { validateStatus: (s) => s < 600 }
    );
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

  /**
   * Stop 2 lần để chắc chắn profile được giải phóng.
   * Kiki cần vài giây để đóng hẳn browser process sau khi stop trả 200 — start ngay
   * sẽ dính SOME_PROGRAM_IS_USING_THIS_PROFILE. Chờ 3s sau lần stop cuối.
   */
  async forceStop(profileId: string): Promise<void> {
    await this.stopProfile(profileId);
    await sleep(1200);
    await this.stopProfile(profileId);
    await sleep(3000);
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
        // Session Kiki hết hạn → retry vô ích, phải đăng nhập lại app Kiki. Fail sớm, báo rõ.
        if (/INVALID_SESSION|UNAUTHORIZED|NOT_LOGIN/i.test(e?.message ?? "")) {
          throw new Error(
            `Kiki chưa đăng nhập / session hết hạn (${e.message}). Mở app Kiki và đăng nhập lại, rồi chạy lại.`
          );
        }
        const busy = /SOME_PROGRAM|busy|already/i.test(e?.message ?? "");
        if (busy && attempt < maxAttempts) {
          onLog?.(`Profile bận, chờ rồi thử lại (${attempt}/${maxAttempts})…`);
          await this.stopProfile(profileId);
          await sleep(5000); // browser process cần vài giây để đóng hẳn
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
