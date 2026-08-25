/**
 * Store file-based cho data health TikCRM (mirror từ extension TikCheck).
 * KHÔNG đụng SQLite migration của shein-auto — lưu JSON dưới data/tikcrm/:
 *   - shop_health.jsonl : lịch sử đầy đủ (append mỗi lần nhận)
 *   - shops/<code>.json : snapshot mới nhất theo shop
 */
import fs from "fs-extra";
import path from "path";

const DIR = path.resolve(process.cwd(), "data", "tikcrm");
const SHOPS = path.join(DIR, "shops");
const LOG = path.join(DIR, "shop_health.jsonl");

export interface ShopHealthRecord {
  received_at: string;
  /** Lần ĐẦU TIÊN shop xuất hiện (thêm mới) — khác received_at (lần update gần nhất). */
  first_seen?: string;
  type: string;
  payload_version?: number;
  payload: any;
}

const safeCode = (s: any) => String(s || "unknown").replace(/[^\w.-]/g, "_").slice(0, 120);

/** first_seen của 1 file snapshot: ưu tiên field đã lưu, fallback birthtime file (shop cũ trước khi có field). */
function resolveFirstSeen(file: string): string | null {
  try {
    const old = fs.readJsonSync(file);
    if (old?.first_seen) return String(old.first_seen);
  } catch { /* file chưa có / hỏng */ }
  try {
    return fs.statSync(file).birthtime.toISOString();
  } catch { return null; }
}

/** Lưu 1 gói health nhận từ extension. Trả về code shop đã lưu. */
export function saveShopHealth(body: { type?: string; payload_version?: number; payload?: any }): string {
  fs.ensureDirSync(SHOPS);
  const payload = body?.payload ?? {};
  const code = safeCode(payload.shop_code || payload.shop_id);
  const file = path.join(SHOPS, code + ".json");
  // Shop đã có snapshot → giữ first_seen cũ (đây là UPDATE); chưa có → lần đầu thêm vào.
  const firstSeen = fs.existsSync(file) ? resolveFirstSeen(file) : null;
  const rec: ShopHealthRecord = {
    received_at: new Date().toISOString(),
    first_seen: firstSeen ?? new Date().toISOString(),
    type: body?.type ?? "shop_health",
    payload_version: body?.payload_version,
    payload,
  };
  fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return code;
}

/** Danh sách snapshot mới nhất của mọi shop (đọc từ thư mục shops/). */
export function listShops(): ShopHealthRecord[] {
  if (!fs.existsSync(SHOPS)) return [];
  const out: ShopHealthRecord[] = [];
  for (const f of fs.readdirSync(SHOPS)) {
    if (!f.endsWith(".json")) continue;
    const fp = path.join(SHOPS, f);
    try {
      const rec = fs.readJsonSync(fp);
      // Shop lưu trước khi có first_seen → fallback birthtime file (thời điểm shop được thêm)
      if (!rec.first_seen) { try { rec.first_seen = fs.statSync(fp).birthtime.toISOString(); } catch { /* bỏ */ } }
      out.push(rec);
    } catch { /* file hỏng → bỏ */ }
  }
  // mới nhất lên đầu
  out.sort((a, b) => (b.received_at || "").localeCompare(a.received_at || ""));
  return out;
}

/** Lịch sử theo 1 shop (quét jsonl, mới nhất trước, giới hạn limit dòng). */
export function getShopHistory(code: string, limit = 60): ShopHealthRecord[] {
  if (!fs.existsSync(LOG)) return [];
  const want = safeCode(code);
  const rows: ShopHealthRecord[] = [];
  const lines = fs.readFileSync(LOG, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ShopHealthRecord;
      const c = safeCode(r.payload?.shop_code || r.payload?.shop_id);
      if (c === want) rows.push(r);
    } catch { /* dòng hỏng → bỏ */ }
  }
  return rows.reverse().slice(0, limit);
}
