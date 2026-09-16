/**
 * Store generic cho các loại data "capture-first" (orders, finance, ...) mirror
 * từ extension. Lưu snapshot mới nhất theo shop dưới data/tikcrm/raw/<kind>/<code>.json.
 * Dùng chung 1 route /webhook/tikcheck/raw/:kind → thêm loại mới không cần sửa server.
 */
import fs from "fs-extra";
import path from "path";

const ROOT = path.resolve(process.cwd(), "data", "tikcrm", "raw");
const safeCode = (s: any) => String(s || "unknown").replace(/[^\w.-]/g, "_").slice(0, 120);
const safeKind = (k: any) => String(k || "x").replace(/[^\w-]/g, "").slice(0, 40);

export function saveRaw(kind: string, body: { payload?: any }): { code: string; count: number } {
  const k = safeKind(kind);
  const p = body?.payload ?? {};
  const code = safeCode(p.shop_code || p.shop_id);
  const dir = path.join(ROOT, k);
  fs.ensureDirSync(dir);
  fs.writeFileSync(path.join(dir, code + ".json"), JSON.stringify({ received_at: new Date().toISOString(), ...p }));
  const count = Number(p.count) ||
    (Array.isArray(p.orders) ? p.orders.length : Array.isArray(p.statements) ? p.statements.length : 0);
  return { code, count };
}

export function getRaw(kind: string, code: string): any | null {
  const f = path.join(ROOT, safeKind(kind), safeCode(code) + ".json");
  if (!fs.existsSync(f)) return null;
  try { return fs.readJsonSync(f); } catch { return null; }
}
