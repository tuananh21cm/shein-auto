/**
 * Public domain từ máy này qua Cloudflare Tunnel (cloudflared) + domain tooltik.app.
 * Tạo tunnel → route DNS <sub>.tooltik.app → viết config yml (hostname → localhost:port)
 * → chạy `cloudflared tunnel run`. Cần: cloudflared trong PATH + ~/.cloudflared/cert.pem
 * (đã login zone tooltik.app). Quản lý list/create/start/stop/delete.
 */
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs-extra";
import path from "path";
import os from "os";

const execFileP = promisify(execFile);
const CF_DIR = path.join(os.homedir(), ".cloudflared");
const DOMAIN = process.env.TUNNEL_DOMAIN || "tooltik.app";

export interface TunnelInfo {
  name: string;
  hostname: string;   // <sub>.tooltik.app
  port: number | null;
  service: string;    // http://localhost:<port>
  uuid: string;
  running: boolean;
  url: string;        // https://<hostname>
}

const ymlPath = (name: string) => path.join(CF_DIR, `${name}.yml`);

/** Tên tunnel đang chạy (quét process cloudflared + command line — Windows PowerShell). */
async function runningTunnelNames(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" | ForEach-Object { $_.CommandLine }`;
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 8000 });
    for (const line of stdout.split(/\r?\n/)) {
      // "... tunnel --config C:\...\<name>.yml run <name>" hoặc "... run <name>"
      const m = line.match(/run\s+([A-Za-z0-9_.-]+)\s*$/) || line.match(/\\([A-Za-z0-9_.-]+)\.yml/);
      if (m) set.add(m[1]);
    }
  } catch { /* không lấy được → coi như none */ }
  return set;
}

function parseYml(txt: string): { uuid: string; hostname: string; service: string } {
  const uuid = (txt.match(/tunnel:\s*(\S+)/) || [])[1] || "";
  const hostname = (txt.match(/hostname:\s*(\S+)/) || [])[1] || "";
  const service = (txt.match(/service:\s*(http[^\s]+)/) || [])[1] || "";
  return { uuid, hostname, service };
}
const portOf = (service: string): number | null => {
  const m = service.match(/:(\d+)/); return m ? Number(m[1]) : null;
};

export async function listTunnels(): Promise<TunnelInfo[]> {
  if (!(await fs.pathExists(CF_DIR))) return [];
  const files = (await fs.readdir(CF_DIR)).filter((f) => f.endsWith(".yml") && !f.endsWith(".bak"));
  const running = await runningTunnelNames();
  const out: TunnelInfo[] = [];
  for (const f of files) {
    const name = f.replace(/\.yml$/, "");
    try {
      const { uuid, hostname, service } = parseYml(await fs.readFile(path.join(CF_DIR, f), "utf8"));
      if (!hostname) continue;
      out.push({ name, hostname, service, port: portOf(service), uuid, running: running.has(name), url: `https://${hostname}` });
    } catch { /* bỏ file lỗi */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Chạy tunnel (detached, sống độc lập với node). */
export function startTunnel(name: string): void {
  const child = spawn("cloudflared", ["tunnel", "--config", ymlPath(name), "run", name], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
}

/** Dừng mọi process cloudflared của tunnel này. */
export async function stopTunnel(name: string): Promise<void> {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "");
  const ps = `Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" | Where-Object { $_.CommandLine -match '\\\\${safe}\\.yml' -or $_.CommandLine -match 'run ${safe}$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  await execFileP("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 8000 }).catch(() => {});
}

/**
 * Tạo tunnel mới: cloudflared tunnel create → route dns → viết yml → (tuỳ) chạy.
 * @param sub subdomain (a-z0-9-). Public URL = https://<sub>.tooltik.app.
 * @param port cổng local cần public (vd 3000).
 */
export async function createTunnel(sub: string, port: number, opts: { run?: boolean } = {}): Promise<TunnelInfo> {
  const name = sub.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!name) throw new Error("Subdomain không hợp lệ (chỉ a-z, 0-9, -)");
  if (!(port > 0 && port < 65536)) throw new Error("Port không hợp lệ");
  if (!(await fs.pathExists(path.join(CF_DIR, "cert.pem")))) {
    throw new Error("Thiếu ~/.cloudflared/cert.pem — chạy `cloudflared tunnel login` (chọn zone tooltik.app) trước.");
  }
  if (await fs.pathExists(ymlPath(name))) throw new Error(`Tunnel "${name}" đã tồn tại`);
  const hostname = `${name}.${DOMAIN}`;

  // 1. Tạo tunnel (in ra id + tạo <uuid>.json). Nếu đã có tên trùng cloudflared báo lỗi.
  const created = await execFileP("cloudflared", ["tunnel", "create", name], { timeout: 30000 });
  const uuid = (created.stdout.match(/[0-9a-f-]{36}/i) || [])[0];
  if (!uuid) throw new Error(`Không lấy được tunnel id: ${created.stdout || created.stderr}`);

  // 2. Route DNS <sub>.tooltik.app → tunnel (tạo CNAME trong Cloudflare).
  await execFileP("cloudflared", ["tunnel", "route", "dns", name, hostname], { timeout: 30000 });

  // 3. Viết config yml.
  const yml = `tunnel: ${uuid}\ncredentials-file: ${path.join(CF_DIR, `${uuid}.json`)}\n\ningress:\n  - hostname: ${hostname}\n    service: http://localhost:${port}\n  - service: http_status:404\n`;
  await fs.writeFile(ymlPath(name), yml, "utf8");

  if (opts.run !== false) startTunnel(name);
  return { name, hostname, service: `http://localhost:${port}`, port, uuid, running: opts.run !== false, url: `https://${hostname}` };
}

/** Xoá tunnel: dừng + xoá DNS + xoá tunnel + xoá yml. */
export async function deleteTunnel(name: string): Promise<void> {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "");
  await stopTunnel(safe);
  await new Promise((r) => setTimeout(r, 800));
  await execFileP("cloudflared", ["tunnel", "delete", "-f", safe], { timeout: 30000 }).catch(() => {});
  await fs.remove(ymlPath(safe)).catch(() => {});
}
