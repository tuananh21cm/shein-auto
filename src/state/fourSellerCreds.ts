import fs from "fs-extra";
import path from "path";

/**
 * Lưu username/password 4Seller để TỰ ĐĂNG NHẬP LẠI khi cookie hết hạn.
 * File data/cookies/accounts/credentials.json — nằm trong data/cookies (git BỎ QUA)
 * → per-máy, không bao giờ lên git. Mật khẩu lưu dạng thường (chấp nhận vì là tài
 * khoản của chính user + ổ máy riêng); muốn chắc hơn thì mã hoá sau.
 */
const CREDS_FILE = path.join(process.cwd(), "data", "cookies", "accounts", "credentials.json");

export interface FourSellerCred {
  username: string;
  password: string;
  uid?: string;      // gắn sau lần login đầu (map uid ↔ creds để auto-refresh theo account)
  label?: string;
  updatedAt: number;
}

type CredMap = Record<string, FourSellerCred>; // key = username (lowercase)

async function readAll(): Promise<CredMap> {
  try { return (await fs.readJson(CREDS_FILE)) as CredMap; } catch { return {}; }
}
async function writeAll(m: CredMap): Promise<void> {
  await fs.ensureDir(path.dirname(CREDS_FILE));
  await fs.writeFile(CREDS_FILE, JSON.stringify(m, null, 2), "utf-8");
}

export async function saveCred(c: { username: string; password: string; uid?: string; label?: string }): Promise<void> {
  const m = await readAll();
  const key = c.username.trim().toLowerCase();
  m[key] = { ...m[key], username: c.username.trim(), password: c.password, uid: c.uid ?? m[key]?.uid, label: c.label ?? m[key]?.label, updatedAt: Date.now() };
  await writeAll(m);
}

export async function getCredByUsername(username: string): Promise<FourSellerCred | null> {
  const m = await readAll();
  return m[username.trim().toLowerCase()] ?? null;
}

export async function getCredByUid(uid: string): Promise<FourSellerCred | null> {
  const m = await readAll();
  return Object.values(m).find((c) => c.uid === String(uid)) ?? null;
}

/** Danh sách creds (ẩn mật khẩu — cho UI liệt kê). */
export async function listCreds(): Promise<Array<Omit<FourSellerCred, "password"> & { hasPassword: boolean }>> {
  const m = await readAll();
  return Object.values(m).map(({ password, ...rest }) => ({ ...rest, hasPassword: !!password }));
}

export async function removeCred(username: string): Promise<void> {
  const m = await readAll();
  delete m[username.trim().toLowerCase()];
  await writeAll(m);
}
