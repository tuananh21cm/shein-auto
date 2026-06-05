import type { Page } from "playwright-core";
import fs from "fs-extra";
import path from "path";
import type { Capture } from "./types";

/** Chỉ giữ response JSON từ domain seller TikTok (API/BFF nội bộ). */
export function isSellerJson(url: string, contentType: string): boolean {
  if (!/json/i.test(contentType)) return false;
  if (!/seller-us\.tiktok\.com|tiktokglobalshop\.com|\/api\/|\/bff\//i.test(url)) return false;
  // loại tracking/log endpoint phổ biến
  if (/google-analytics|doubleclick|\/monitor\/|\/log\/|\/track/i.test(url)) return false;
  return true;
}

export interface CaptureBusOptions {
  /** Nếu set → ghi mỗi capture ra đĩa (discovery mode). */
  dumpDir?: string;
  /** Tên route hiện tại (để đặt thư mục dump). */
  routeKey?: string;
}

export interface CaptureBus {
  snapshot(): Capture[];
  clear(): void;
  detach(): void;
  setRoute(key: string): void;
  count(): number;
}

/** Gắn listener response. Gọi TRƯỚC page.goto. */
export function attachCaptureBus(page: Page, opts: CaptureBusOptions = {}): CaptureBus {
  let buffer: Capture[] = [];
  let routeKey = opts.routeKey ?? "unknown";
  let dumpSeq = 0;

  const onResp = async (res: any) => {
    try {
      const url = res.url();
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!isSellerJson(url, ct)) return;
      const text = await res.text().catch(() => "");
      if (!text) return;
      let body: any;
      try { body = JSON.parse(text); } catch { return; }
      buffer.push({ url, status: res.status(), body });

      if (opts.dumpDir) {
        const dir = path.join(opts.dumpDir, routeKey);
        await fs.ensureDir(dir);
        const safe = String(++dumpSeq).padStart(3, "0");
        await fs.writeFile(
          path.join(dir, `${safe}.json`),
          JSON.stringify({ url, status: res.status(), body }, null, 2),
          "utf-8"
        );
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResp);

  return {
    snapshot: () => buffer.slice(),
    clear: () => { buffer = []; },
    detach: () => page.off("response", onResp),
    setRoute: (key: string) => { routeKey = key; dumpSeq = 0; },
    count: () => buffer.length,
  };
}
