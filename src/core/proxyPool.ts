/**
 * proxyPool — đọc danh sách proxy (.txt) + dùng proxy-chain bridge SOCKS5/HTTP có AUTH thành
 * local HTTP proxy (không auth) để Chromium dùng được (Chromium KHÔNG hỗ trợ SOCKS5 auth trực tiếp).
 *
 * Format mỗi dòng: "host:port:user:pass" | "host:port" | "socks5://user:pass@host:port".
 */
import fs from "fs-extra";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

export interface ProxyEntry {
  raw: string;
  upstream: string; // socks5://user:pass@host:port
  label: string;    // che pass
}
export interface ProxyBridge {
  upstream: string;
  local: string;    // http://127.0.0.1:port (không auth) — Chrome dùng cái này
  label: string;
}

/** Parse 1 dòng proxy → upstream URL. null nếu rỗng/comment/không hợp lệ. */
export function parseProxyLine(line: string, scheme = "socks5"): ProxyEntry | null {
  const s = (line || "").trim();
  if (!s || s.startsWith("#")) return null;
  if (/^(socks[45]?|https?):\/\//i.test(s)) {
    return { raw: s, upstream: s, label: s.replace(/:[^:@/]+@/, ":***@") };
  }
  const parts = s.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return { raw: s, upstream: `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`, label: `${scheme}://${host}:${port}` };
  }
  if (parts.length === 2) {
    const [host, port] = parts;
    return { raw: s, upstream: `${scheme}://${host}:${port}`, label: `${scheme}://${host}:${port}` };
  }
  return null;
}

/** Đọc + parse file proxy .txt. */
export async function loadProxies(filePath: string, scheme = "socks5"): Promise<ProxyEntry[]> {
  if (!(await fs.pathExists(filePath))) throw new Error(`Không thấy file proxy: ${filePath}`);
  const txt = await fs.readFile(filePath, "utf-8");
  const out: ProxyEntry[] = [];
  const seen = new Set<string>();
  for (const line of txt.split(/\r?\n/)) {
    const p = parseProxyLine(line, scheme);
    if (p && !seen.has(p.upstream)) { seen.add(p.upstream); out.push(p); }
  }
  return out;
}

/** Bridge từng proxy → local HTTP. Trả bridges + hàm close (giải phóng port local). */
export async function startBridges(
  proxies: ProxyEntry[],
  onLog?: (m: string) => void
): Promise<{ bridges: ProxyBridge[]; close: () => Promise<void> }> {
  const log = onLog ?? (() => {});
  const bridges: ProxyBridge[] = [];
  for (const p of proxies) {
    try {
      const local = await anonymizeProxy(p.upstream);
      bridges.push({ upstream: p.upstream, local, label: p.label });
      log(`  bridge ${p.label} → ${local}`);
    } catch (e: any) {
      log(`  ⚠️ bridge ${p.label} lỗi: ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  const close = async () => {
    for (const b of bridges) { try { await closeAnonymizedProxy(b.local, true); } catch { /* ignore */ } }
  };
  return { bridges, close };
}
