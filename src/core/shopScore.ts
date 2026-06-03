/**
 * Chấm điểm "sức khỏe" một shop 4Seller dựa HOÀN TOÀN trên dữ liệu list API
 * (/api/listing/tiktok/page) — KHÔNG gọi detail từng listing.
 *
 * Tiêu chí (list API hỗ trợ):
 *   - Title quá ngắn / quá dài            (productName)
 *   - Ảnh không đủ tối thiểu (mặc định 4) (mainImage, pipe-separated)
 *   - Ngách có bị loạn không              (phân bố categoryId)
 *   - Giá hợp lệ                          (lowPrice/highPrice/originalPrice)
 *   - Tồn kho / listing lỗi               (availableStock, errMsg/failedMessage)
 *
 * Mô tả / attribute / brand KHÔNG có trong list API nên không chấm ở đây.
 */

export interface ScoreListing {
  id: string | number;
  productName?: string | null;
  mainImage?: string | null; // các URL nối bằng dấu "|"
  categoryId?: string | null;
  lowPrice?: number | null;
  highPrice?: number | null;
  originalPrice?: number | null;
  availableStock?: number | null;
  variationCount?: number | null;
  errMsg?: string | null;
  failedMessage?: string | null;
}

export interface CategoryName {
  name: string;
  nodePath: string;
}

export interface ScoreThresholds {
  /** Title ngắn hơn ngưỡng này = quá ngắn (ký tự) */
  titleMin: number;
  /** Title dài hơn ngưỡng này = quá dài (ký tự) */
  titleMax: number;
  /** Số ảnh tối thiểu cho 1 listing */
  minImages: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  titleMin: 30,
  titleMax: 150,
  minImages: 4,
};

export interface IssueSample {
  id: string | number;
  productName: string;
  detail: string; // mô tả ngắn vấn đề (vd "12 ký tự", "2 ảnh")
}

export interface IssueBucket {
  count: number;
  pct: number; // % trên tổng listing
  samples: IssueSample[];
}

export interface NicheCategory {
  categoryId: string;
  categoryName: string;
  nodePath: string;
  count: number;
  percent: number;
}

export interface ShopScoreResult {
  total: number;
  scores: {
    overall: number;
    grade: "A" | "B" | "C" | "D" | "F";
    title: number;
    image: number;
    niche: number;
    price: number;
    stock: number;
  };
  issues: {
    titleShort: IssueBucket;
    titleLong: IssueBucket;
    fewImages: IssueBucket;
    noPrice: IssueBucket;
    outOfStock: IssueBucket;
    hasError: IssueBucket;
  };
  niche: {
    categoryCount: number;
    topShare: number; // % của category lớn nhất
    top3Share: number; // % của 3 category lớn nhất
    hhi: number; // Herfindahl index (0-100), càng cao càng tập trung
    chaotic: boolean; // true nếu ngách bị loạn
    categories: NicheCategory[];
  };
  priceStats: {
    min: number | null;
    max: number | null;
    avg: number | null;
    currency: string;
  };
  thresholds: ScoreThresholds;
}

const SAMPLE_LIMIT = 8;

const imageCount = (rec: ScoreListing): number =>
  rec.mainImage ? rec.mainImage.split("|").filter((s) => s.trim()).length : 0;

const titleLen = (rec: ScoreListing): number =>
  (rec.productName ?? "").trim().length;

const validPrice = (rec: ScoreListing): number | null => {
  const candidates = [rec.lowPrice, rec.highPrice, rec.originalPrice];
  for (const c of candidates) {
    if (typeof c === "number" && c > 0) return c;
  }
  return null;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (part: number, total: number): number =>
  total > 0 ? round1((part / total) * 100) : 0;

const gradeOf = (overall: number): ShopScoreResult["scores"]["grade"] => {
  if (overall >= 85) return "A";
  if (overall >= 70) return "B";
  if (overall >= 55) return "C";
  if (overall >= 40) return "D";
  return "F";
};

/**
 * @param listings  Tất cả listing active của shop (từ list API)
 * @param categoryNames  Map categoryId → {name, nodePath} đã resolve sẵn
 */
export function computeShopScore(
  listings: ScoreListing[],
  categoryNames: Record<string, CategoryName>,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS
): ShopScoreResult {
  const total = listings.length;

  const mkBucket = (): { count: number; samples: IssueSample[] } => ({
    count: 0,
    samples: [],
  });
  const titleShort = mkBucket();
  const titleLong = mkBucket();
  const fewImages = mkBucket();
  const noPrice = mkBucket();
  const outOfStock = mkBucket();
  const hasError = mkBucket();

  const pushSample = (
    b: { count: number; samples: IssueSample[] },
    rec: ScoreListing,
    detail: string
  ) => {
    b.count++;
    if (b.samples.length < SAMPLE_LIMIT) {
      b.samples.push({
        id: rec.id,
        productName: (rec.productName ?? "").slice(0, 100),
        detail,
      });
    }
  };

  const catCount: Record<string, number> = {};
  const priceVals: number[] = [];

  for (const rec of listings) {
    const len = titleLen(rec);
    if (len < thresholds.titleMin) pushSample(titleShort, rec, `${len} ký tự`);
    else if (len > thresholds.titleMax) pushSample(titleLong, rec, `${len} ký tự`);

    const imgs = imageCount(rec);
    if (imgs < thresholds.minImages) pushSample(fewImages, rec, `${imgs} ảnh`);

    const price = validPrice(rec);
    if (price === null) pushSample(noPrice, rec, "không có giá hợp lệ");
    else priceVals.push(price);

    if (rec.availableStock !== null && rec.availableStock !== undefined && rec.availableStock <= 0) {
      pushSample(outOfStock, rec, "hết hàng");
    }

    const err = (rec.errMsg || rec.failedMessage || "").trim();
    if (err) pushSample(hasError, rec, err.slice(0, 80));

    const cid = String(rec.categoryId || "unknown");
    catCount[cid] = (catCount[cid] || 0) + 1;
  }

  // ── Phân bố ngách ──
  const categories: NicheCategory[] = Object.entries(catCount)
    .map(([cid, count]) => ({
      categoryId: cid,
      categoryName: categoryNames[cid]?.name ?? cid,
      nodePath: categoryNames[cid]?.nodePath ?? "",
      count,
      percent: pct(count, total),
    }))
    .sort((a, b) => b.count - a.count);

  const topShare = categories[0]?.percent ?? 0;
  const top3Share = round1(
    categories.slice(0, 3).reduce((s, c) => s + c.percent, 0)
  );
  // Herfindahl index: tổng bình phương thị phần (0-1) → scale 0-100
  const hhi = round1(
    categories.reduce((s, c) => s + Math.pow(c.count / Math.max(total, 1), 2), 0) * 100
  );
  // Loạn ngách nếu: nhiều category VÀ không có nhóm nào chiếm ưu thế.
  const chaotic = categories.length >= 5 && top3Share < 60;

  // ── Sub-scores (0-100) ──
  const titleBad = titleShort.count + titleLong.count;
  const titleScore = round1(100 - pct(titleBad, total));
  const imageScore = round1(100 - pct(fewImages.count, total));
  const priceScore = round1(100 - pct(noPrice.count, total));
  const stockScore = round1(100 - pct(outOfStock.count, total));
  // Niche score: kết hợp top3Share (tập trung) — clamp 0-100.
  const nicheScore = Math.max(0, Math.min(100, round1(top3Share * 1.1)));

  const overall = round1(
    titleScore * 0.2 +
      imageScore * 0.25 +
      nicheScore * 0.25 +
      priceScore * 0.15 +
      stockScore * 0.15
  );

  const finishBucket = (b: { count: number; samples: IssueSample[] }): IssueBucket => ({
    count: b.count,
    pct: pct(b.count, total),
    samples: b.samples,
  });

  const priceStats = {
    min: priceVals.length ? Math.min(...priceVals) : null,
    max: priceVals.length ? Math.max(...priceVals) : null,
    avg: priceVals.length
      ? round1(priceVals.reduce((s, v) => s + v, 0) / priceVals.length)
      : null,
    currency: "",
  };

  return {
    total,
    scores: {
      overall,
      grade: gradeOf(overall),
      title: titleScore,
      image: imageScore,
      niche: nicheScore,
      price: priceScore,
      stock: stockScore,
    },
    issues: {
      titleShort: finishBucket(titleShort),
      titleLong: finishBucket(titleLong),
      fewImages: finishBucket(fewImages),
      noPrice: finishBucket(noPrice),
      outOfStock: finishBucket(outOfStock),
      hasError: finishBucket(hasError),
    },
    niche: { categoryCount: categories.length, topShare, top3Share, hhi, chaotic, categories },
    priceStats,
    thresholds,
  };
}
