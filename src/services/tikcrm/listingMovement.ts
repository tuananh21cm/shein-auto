/**
 * Biến động view per-listing giữa 2 ngày snapshot gần nhất.
 * So pv_28d từng SP (join theo product_id) → phân loại: tăng / giữ nguyên / giảm / SP mới / SP mất.
 * Ngưỡng "giữ nguyên": |Δ| < 2% (hoặc <5 tuyệt đối) — tránh nhiễu nhỏ của cửa sổ trượt 28d.
 */
import { listListingDays, getDaySnapshot } from "./dailyStore";

export interface MoveItem {
  product_id: string; product_name: string; image?: string; pv_28d: number; prev_pv: number; d_pv: number; pct: number;
}
export interface MovementResult {
  ok: boolean; reason?: string;
  from_day?: string; to_day?: string; snapshot_days?: number;
  counts?: { up: number; same: number; down: number; added: number; removed: number };
  up?: MoveItem[]; same?: MoveItem[]; down?: MoveItem[]; added?: MoveItem[]; removed?: MoveItem[];
}

const arrOf = (snapDay: any) => (snapDay?.listings?.listings ?? []) as any[];

export function getListingMovement(code: string): MovementResult {
  const days = listListingDays(code);
  if (days.length < 2) {
    return { ok: false, reason: "cần ≥2 ngày snapshot (đang có " + days.length + ") — sẽ đủ khi shop cào thêm 1 ngày nữa", snapshot_days: days.length };
  }
  const toDay = days[0], fromDay = days[1];
  const to = arrOf(getDaySnapshot(code, toDay));
  const from = arrOf(getDaySnapshot(code, fromDay));
  const fromMap = new Map<string, any>(from.map((x) => [String(x.product_id), x]));
  const toIds = new Set(to.map((x) => String(x.product_id)));

  const up: MoveItem[] = [], same: MoveItem[] = [], down: MoveItem[] = [], added: MoveItem[] = [];
  for (const t of to) {
    const pv = Number(t.pv_28d) || 0;
    const f = fromMap.get(String(t.product_id));
    if (!f) { added.push({ product_id: String(t.product_id), product_name: t.product_name, pv_28d: pv, prev_pv: 0, d_pv: pv, pct: 100 }); continue; }
    const prev = Number(f.pv_28d) || 0;
    const d = pv - prev;
    const rel = Math.abs(d) / Math.max(prev, 1);
    const it: MoveItem = { product_id: String(t.product_id), product_name: t.product_name, image: t.image || "", pv_28d: pv, prev_pv: prev, d_pv: d, pct: prev ? Math.round((d / prev) * 1000) / 10 : 100 };
    if (d > 0 && (rel >= 0.02 && Math.abs(d) >= 5)) up.push(it);
    else if (d < 0 && (rel >= 0.02 && Math.abs(d) >= 5)) down.push(it);
    else same.push(it);
  }
  const removed: MoveItem[] = from.filter((f) => !toIds.has(String(f.product_id)))
    .map((f) => ({ product_id: String(f.product_id), product_name: f.product_name, pv_28d: 0, prev_pv: Number(f.pv_28d) || 0, d_pv: -(Number(f.pv_28d) || 0), pct: -100 }));

  up.sort((a, b) => b.d_pv - a.d_pv);
  down.sort((a, b) => a.d_pv - b.d_pv);

  return {
    ok: true, from_day: fromDay, to_day: toDay, snapshot_days: days.length,
    counts: { up: up.length, same: same.length, down: down.length, added: added.length, removed: removed.length },
    up, same, down, added, removed,
  };
}
