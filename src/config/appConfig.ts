import fs from "fs";
import path from "path";

const CONFIG_ROOT = path.resolve(process.cwd(), "config");

const readJson = <T>(file: string): T => {
  const raw = fs.readFileSync(path.join(CONFIG_ROOT, file), "utf-8");
  return JSON.parse(raw) as T;
};

interface PricingFile {
  // Formula mới: (price + shipFee) * multiplier + extraAdd
  shipFee?: number;
  multiplier?: number;
  extraAdd?: number;
  // Formula cũ (backward compat): (price + offset) / divisor
  offset?: number;
  divisor?: number;
  defaultQty: number;
  defaultWeight: string;
  defaultDimensions: { length: string; width: string; height: string };
}
interface WorkerFile {
  autoCron: boolean;
  concurrency: number;
  headless: boolean;
  fileRouterCron: string;
  queueManagerCron: string;
  imageUploadWaitPerImageMs: number;
  imageUploadMaxImages: number;
  descriptionImagesCount: number;
  descriptionMaxAttributes: number;
  /** Bật/tắt chèn ảnh GỘP Size Guide (bảng + How To Measure) vào gallery sau ảnh main.
   *  Mặc định false: TikTok hiện không cho dùng ảnh dạng này làm ảnh sản phẩm. */
  sizeGuideGalleryImage?: boolean;
  /** Bật/tắt điền mục Specifics (map SHEIN attributes → dropdown 4Seller). Mặc định false. */
  fillSpecifics?: boolean;
  /** Ảnh "nhiều màu" làm ảnh main. style A=collage grid, B=main+strip, C=main+badge. */
  colorShowcase?: { enabled: boolean; style: "A" | "B" | "C" };
  imageRemake?: {
    enabled: boolean;
    preset: "light" | "standard" | "aggressive";
    flip: boolean;
    perShopSeed: boolean;
  };
}
interface SizeMapFile {
  map: Record<string, string>;
}
export interface SpecificsMapFile {
  // 1 key SHEIN có thể trỏ 1 hoặc NHIỀU field 4Seller (thử lần lượt, field nào có + khớp thì điền).
  keyMap: Record<string, string | string[]>;
  valueSynonyms: Record<string, string>;
}
interface CategoriesFile {
  categories: string[];
}

export interface ResearchNiche {
  key: string;
  group: string;
  query: string;
}
export interface ResearchFile {
  country: string;
  perNichePerPage: number;
  niches: ResearchNiche[];
  weights: { win: number; nicheHeat: number; margin: number; demandFit: number };
  margin: { sweetLow: number; sweetHigh: number; hardMax: number };
  candidate: {
    targetCount: number;
    minOpportunity: number;
    maxPerNiche: number;
    minReviewsForHot: number;
  };
  validation?: {
    minRating: number;
    minSold: number;
    fitMin: number;
    localShipMaxDays: number;
    watchScore: number;
    deepDiscountPct: number;
    minUgcForContent: number;
    ipBrands: string[];
  };
  cron?: {
    enabled: boolean;
    schedule: string;
    timezone?: string;
    autoEnrich?: boolean;
    enrichProfileId?: string;
    enrichLimit?: number;
  };
}

export interface TiktokFile {
  enabled: boolean;
  profileId: string;
  cron: string;
  timezone?: string;
  model: string;
  analyze: boolean;
}

let _pricing: PricingFile | null = null;
let _worker: WorkerFile | null = null;
let _tiktok: TiktokFile | null = null;
let _sizeMap: SizeMapFile | null = null;
let _specificsMap: SpecificsMapFile | null = null;
let _categories: CategoriesFile | null = null;
let _research: ResearchFile | null = null;

export const pricing = (): PricingFile =>
  (_pricing ??= readJson<PricingFile>("pricing.json"));

export const workerConfig = (): WorkerFile =>
  (_worker ??= readJson<WorkerFile>("worker.json"));

export const sizeMap = (): Record<string, string> =>
  (_sizeMap ??= readJson<SizeMapFile>("size-map.json")).map;

export const specificsMap = (): SpecificsMapFile =>
  (_specificsMap ??= readJson<SpecificsMapFile>("specifics-map.json"));

export const tiktokCategories = (): string[] =>
  (_categories ??= readJson<CategoriesFile>("tiktok-categories.json")).categories;

export const researchConfig = (): ResearchFile =>
  (_research ??= readJson<ResearchFile>("research.json"));

export const tiktokConfig = (): TiktokFile =>
  (_tiktok ??= readJson<TiktokFile>("tiktok.json"));

/**
 * Tính giá bán cuối cùng từ giá gốc.
 *
 * Ưu tiên formula mới: (price + shipFee) × multiplier + extraAdd
 * Fallback formula cũ: (price + offset) / divisor (cho config legacy)
 */
export const computeFinalPrice = (originalPrice: number): number => {
  const p = pricing();
  if (typeof p.shipFee === "number" || typeof p.multiplier === "number") {
    const ship = typeof p.shipFee === "number" ? p.shipFee : 0;
    const mult = typeof p.multiplier === "number" ? p.multiplier : 1;
    const extra = typeof p.extraAdd === "number" ? p.extraAdd : 0;
    return (originalPrice + ship) * mult + extra;
  }
  // Legacy fallback
  const offset = typeof p.offset === "number" ? p.offset : 0;
  const divisor = typeof p.divisor === "number" && p.divisor > 0 ? p.divisor : 1;
  return (originalPrice + offset) / divisor;
};

/** Force reload config từ disk (dùng cho Settings UI sau này). */
export const reloadAppConfig = (): void => {
  _pricing = null;
  _worker = null;
  _sizeMap = null;
  _specificsMap = null;
  _categories = null;
  _research = null;
};
