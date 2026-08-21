/**
 * SHEIN anti-crawler: khi nghi trình duyệt là crawler, SHEIN THỔI GIÁ một số variant
 * lên x3-x4 (vd 10 màu thì 5 màu giá nhảy gấp 3-4 lần). Hàm này phát hiện các variant
 * bị thổi (giá ≈ x3-x4 so với CỤM GIÁ THƯỜNG) và chia về gần giá gốc.
 *
 * Nguyên tắc:
 *  - baseline = trung vị của CỤM GIÁ THẤP (variant giá thường) — robust kể cả khi ~50%
 *    variant bị thổi.
 *  - variant có ratio = giá / baseline ≥ ~2.5 (x3-x4) → chia cho round(ratio) (3,4,5)
 *    → đưa về sát baseline. CHỈ sửa nếu kết quả rơi gần baseline (tránh sửa nhầm variant
 *    thật sự đắt như bundle/plus-size).
 *  - variant giá thường (ratio < 2.5) → GIỮ NGUYÊN.
 *
 * Mutate trực tiếp variantPrice (giữ format string/number gốc). Trả số variant đã sửa.
 */
export function fixInflatedVariantPrices(
  variantPrice: Array<Record<string, string | number>> | undefined,
  opts?: { onLog?: (m: string) => void; ratioMin?: number },
): { fixed: number; baseline: number | null } {
  const log = opts?.onLog ?? (() => {});
  // Buff là x3-x4. Chỉ coi là "thổi giá" khi ratio ≥ 2.7 (gần x3). Variant chênh CHƯA
  // tới x2 (và cả vùng 2x–2.7x mập mờ) = GIÁ THẬT → giữ nguyên, không đụng.
  const ratioMin = Math.max(2.0, opts?.ratioMin ?? 2.7);
  if (!Array.isArray(variantPrice) || variantPrice.length < 3) return { fixed: 0, baseline: null };

  const parse = (raw: any): number | null => {
    const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const entries = variantPrice.map((it) => {
    const key = Object.keys(it)[0];
    return { it, key, num: parse(it[key]) };
  });
  const nums = entries.map((e) => e.num).filter((n): n is number => n != null);
  if (nums.length < 3) return { fixed: 0, baseline: null };

  // baseline = trung vị của CỤM GIÁ THẤP (các giá ≤ min×1.5 — cụm "giá thường").
  const sorted = [...nums].sort((a, b) => a - b);
  const min = sorted[0];
  const lowCluster = sorted.filter((p) => p <= min * 1.5);
  const baseline = lowCluster[Math.floor((lowCluster.length - 1) / 2)];
  if (!baseline || baseline <= 0) return { fixed: 0, baseline: null };

  let fixed = 0;
  for (const e of entries) {
    if (e.num == null) continue;
    const ratio = e.num / baseline;
    // LUẬT: chênh < 2x so với variant khác = giá thật → tuyệt đối không sửa.
    if (ratio < 2.0) continue;
    if (ratio < ratioMin) continue; // 2x–2.7x: mập mờ, không phải x3-x4 → giữ nguyên
    const factor = Math.min(5, Math.max(3, Math.round(ratio)));
    const corrected = Math.round((e.num / factor) * 100) / 100;
    // chỉ sửa nếu về gần baseline (0.55×–1.8×) → tránh đụng variant thật sự đắt
    if (corrected >= baseline * 0.55 && corrected <= baseline * 1.8) {
      const wasString = typeof e.it[e.key] === "string";
      e.it[e.key] = wasString ? String(corrected) : corrected;
      log(`💲 Giá thổi: "${e.key}" $${e.num} → $${corrected} (÷${factor}, baseline $${baseline})`);
      fixed++;
    }
  }
  if (fixed) log(`💲 Đã chuẩn hoá ${fixed}/${entries.length} variant bị SHEIN thổi giá (baseline $${baseline}).`);
  return { fixed, baseline };
}
