/**
 * Lưu cookie 4Seller "team khác" để tạo video — TÁCH RIÊNG khỏi account thật của tool
 * (không ảnh hưởng routing/listing). Chỉ phục vụ màn Video: chọn account → hiện lại
 * shop/listing lần trước. File data/video-ext-accounts.json (đã gitignore theo data/).
 */
import fs from "fs-extra";
import path from "path";

const FILE = path.resolve(process.cwd(), "data", "video-ext-accounts.json");

export interface VideoExtShop { id: number | string; name: string }
export interface VideoExtAccount {
  id: string;
  label: string;
  cookie: string;               // raw (JSON export hoặc header) — chỉ ở máy này
  shops: VideoExtShop[];        // cache để hiện ngay khỏi gọi lại 4Seller
  updatedAt: number;
}

async function read(): Promise<VideoExtAccount[]> {
  try {
    const j = await fs.readJson(FILE);
    return Array.isArray(j?.accounts) ? j.accounts : [];
  } catch {
    return [];
  }
}
async function write(accounts: VideoExtAccount[]): Promise<void> {
  await fs.ensureDir(path.dirname(FILE));
  await fs.writeJson(FILE, { accounts }, { spaces: 2 });
}

export const listVideoExtAccounts = (): Promise<VideoExtAccount[]> => read();

export async function getVideoExtAccount(id: string): Promise<VideoExtAccount | null> {
  return (await read()).find((a) => a.id === id) ?? null;
}

/** Thêm mới hoặc cập nhật (theo id) — dùng khi lưu cookie / refresh shop list. */
export async function upsertVideoExtAccount(a: {
  id?: string; label: string; cookie: string; shops: VideoExtShop[];
}): Promise<VideoExtAccount> {
  const accounts = await read();
  const id = a.id || `ext-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec: VideoExtAccount = { id, label: a.label, cookie: a.cookie, shops: a.shops, updatedAt: Date.now() };
  const i = accounts.findIndex((x) => x.id === id);
  if (i >= 0) accounts[i] = rec; else accounts.push(rec);
  await write(accounts);
  return rec;
}

export async function deleteVideoExtAccount(id: string): Promise<void> {
  await write((await read()).filter((a) => a.id !== id));
}
