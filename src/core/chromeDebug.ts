/**
 * chromeDebug — đảm bảo Chrome debug (CDP) đang chạy ở cdpUrl. Probe cổng; nếu chưa lên thì
 * tự spawn Chrome với --remote-debugging-port (user-data-dir riêng, không đụng Chrome cá nhân).
 * Dùng chung cho auto-crawler (tự bật) và endpoint /admin/api/chrome/launch.
 */
import fs from "fs-extra";
import path from "path";
import net from "net";

export interface EnsureChromeResult {
  ok: boolean;
  already?: boolean;
  launched?: boolean;
  exe?: string;
  error?: string;
}

function parseHostPort(cdpUrl: string): { host: string; port: number } {
  try {
    const u = new URL(cdpUrl);
    return { host: u.hostname || "127.0.0.1", port: Number(u.port) || 9222 };
  } catch {
    return { host: "127.0.0.1", port: 9222 };
  }
}

export function probePort(host: string, port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (v: boolean) => { if (!done) { done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
    sock.once("connect", () => fin(true));
    sock.once("error", () => fin(false));
    sock.setTimeout(timeout, () => fin(false));
  });
}

/** Đảm bảo Chrome debug đang chạy. Idempotent: đã chạy → already=true. */
export async function ensureChromeDebug(
  cdpUrl = "http://127.0.0.1:9222",
  onLog?: (m: string) => void
): Promise<EnsureChromeResult> {
  const log = onLog ?? (() => {});
  const { host, port } = parseHostPort(cdpUrl);

  if (await probePort(host, port)) return { ok: true, already: true };

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  let exe = "";
  for (const c of candidates) { if (c && (await fs.pathExists(c))) { exe = c; break; } }
  if (!exe) return { ok: false, error: "Không tìm thấy chrome.exe (Program Files / LOCALAPPDATA)." };

  const userDir = process.env.CHROME_DEBUG_DIR || "C:\\chrome-debug-shein";
  const { spawn } = await import("child_process");
  log(`🟢 Bật Chrome debug ${host}:${port} (profile ${userDir})…`);
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${userDir}`,
    "https://us.shein.com",
  ], { detached: true, stdio: "ignore" });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probePort(host, port)) return { ok: true, launched: true, exe };
  }
  return { ok: false, error: "Đã spawn Chrome nhưng cổng chưa lên (có thể user-data-dir đang mở ở instance khác — tắt hết Chrome rồi thử lại)." };
}
