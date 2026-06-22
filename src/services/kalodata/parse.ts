/**
 * Parse số liệu Kalodata. Revenue hiển thị dạng "₫8,009.00b" / "₫367.82m" / "₫505.88k".
 * (Tài khoản để currency VND — chỉ cần GIÁ TRỊ TƯƠNG ĐỐI để so sánh ngách/sp.)
 */

/** "₫8,009.00b" → 8009000000000. Hỗ trợ t/b/m/k. NULL nếu không parse được. */
export function parseKaloNum(s: any): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const str = String(s).replace(/[₫$€£,\s]/g, "").toLowerCase().trim();
  const m = str.match(/^([\d.]+)\s*([tbmk])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = { t: 1e12, b: 1e9, m: 1e6, k: 1e3 };
  if (m[2]) n *= mult[m[2]] ?? 1;
  return n;
}

/**
 * Độ dốc trend (revenue_trend 30 ngày): avg nửa cuối / avg nửa đầu.
 * > 1 = đang lên, < 1 = đang xuống. NULL nếu thiếu data.
 */
export function trendSlope(arr: any): number | null {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const nums = arr.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (nums.length < 4) return null;
  const half = Math.floor(nums.length / 2);
  const first = nums.slice(0, half);
  const second = nums.slice(half);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const a1 = avg(first);
  const a2 = avg(second);
  if (a1 <= 0) return null;
  return Math.round((a2 / a1) * 1000) / 1000;
}
