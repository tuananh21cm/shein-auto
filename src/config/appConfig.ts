import fs from "fs";
import path from "path";

const CONFIG_ROOT = path.resolve(process.cwd(), "config");

const readJson = <T>(file: string): T => {
  const raw = fs.readFileSync(path.join(CONFIG_ROOT, file), "utf-8");
  return JSON.parse(raw) as T;
};

interface PricingFile {
  // Formula: (price + shipFee) * multiplier + extraAdd
  shipFee?: number;
  multiplier?: number;
  extraAdd?: number;
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
  /** Test giai đoạn đầu: click "Save" (lưu NHÁP) thay vì "Save & Publish". Mặc định false (đăng live). */
  saveDraftOnly?: boolean;
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
  dropScore?: {
    weights: { trend: number; cheap: number; refundSafe: number; supply: number };
    cheap: { idealCost: number; maxCost: number };
    refund: { fitMin: number; ratingMin: number };
    groupSimplicity: Record<string, number>;
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

export interface PublishFile {
  enabled: boolean;
  cookieUser: string;
  intervalMinMinutes: number;
  intervalMaxMinutes: number;
  perShopPerCycle: number;
  interShopJitterMinSec: number;
  interShopJitterMaxSec: number;
}

export interface CrawlFile {
  enabled: boolean;
  batchSize: number;
  intervalSeconds: number;
  idleSeconds: number;
  cdpUrl: string;
  maxAttempts: number;
}

/** Template POD T-shirt (config/pod.json). Mọi áo POD dùng chung; chỉ khác title + random màu. */
export interface PodFile {
  /** Danh sách ngách — mỗi listing random 1. */
  categories: string[];
  /** Giá bán CUỐI (string "23.99"), KHÔNG nhân multiplier global. */
  finalPrice: string;
  /** Phụ giá đi đơn theo size: { "XXL": 2, "3XL": 4 } — cộng vào finalPrice cho size đó. */
  sizeSurcharge?: Record<string, number>;
  /** Folder ảnh material (absolute). Rỗng = fallback env POD_MATERIAL_DIR → mặc định data/pod-materials. */
  materialDir?: string;
  brand_name?: string;
  sizes: string[];
  palette: string[];
  colorsPerListing: { min: number; max: number };
  /** Số ảnh phụ (material) chèn sau ảnh main. Random ảnh nào, nhưng đúng số lượng này. */
  auxImages?: number;
  /** @deprecated thay bằng auxImages. */
  materialsPick?: { min: number; max: number };
  attributes: Record<string, string>;
  size_chart: { unit: string; data: Record<string, string>[] };
  measure_guide: { items: { index?: string; name: string; desc: string }[]; image: string | null };
  descriptionTemplate: string;
}

let _pricing: PricingFile | null = null;
let _worker: WorkerFile | null = null;
let _tiktok: TiktokFile | null = null;
let _sizeMap: SizeMapFile | null = null;
let _specificsMap: SpecificsMapFile | null = null;
let _categories: CategoriesFile | null = null;
let _research: ResearchFile | null = null;
let _pod: PodFile | null = null;

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

export const podConfig = (): PodFile =>
  (_pod ??= readJson<PodFile>("pod.json"));

export const tiktokConfig = (): TiktokFile =>
  (_tiktok ??= readJson<TiktokFile>("tiktok.json"));

let _publish: PublishFile | null = null;
export const publishConfig = (): PublishFile =>
  (_publish ??= readJson<PublishFile>("publish.json"));

let _crawl: CrawlFile | null = null;
export const crawlConfig = (): CrawlFile =>
  (_crawl ??= readJson<CrawlFile>("crawl.json"));

/**
 * Tính giá bán cuối cùng từ giá gốc: (price + shipFee) × multiplier + extraAdd.
 * Đọc từ pricing.json global (đã bỏ per-user override + formula legacy offset/divisor).
 */
export const computeFinalPrice = (originalPrice: number): number => {
  const p = pricing();
  const ship = typeof p.shipFee === "number" ? p.shipFee : 0;
  const mult = typeof p.multiplier === "number" ? p.multiplier : 1;
  const extra = typeof p.extraAdd === "number" ? p.extraAdd : 0;
  return (originalPrice + ship) * mult + extra;
};

/** Force reload config từ disk (dùng cho Settings UI sau này). */
export const reloadAppConfig = (): void => {
  _pricing = null;
  _worker = null;
  _sizeMap = null;
  _specificsMap = null;
  _categories = null;
  _research = null;
  _pod = null;
};
