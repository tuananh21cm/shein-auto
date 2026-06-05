/** Tìm đệ quy value đầu tiên non-empty cho `key`. Port từ detailSignals.ts. */
export function deepFind(o: any, key: string, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 8) return undefined;
  if (o[key] !== undefined && o[key] !== null && o[key] !== "") return o[key];
  for (const k of Object.keys(o)) {
    const r = deepFind(o[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Thử lần lượt nhiều tên key ứng viên, trả match đầu tiên. */
export function deepFindFirst(o: any, keys: string[]): any {
  for (const k of keys) {
    const v = deepFind(o, k);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Parse số từ nhiều dạng: "$1,234.5", "12.3%", {amount}, number. */
export function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    return toNum(v.amount ?? v.usdAmount ?? v.value ?? v.val);
  }
  const s = String(v).replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
