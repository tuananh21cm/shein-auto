import fs from "fs";
import path from "path";

const CONFIG_ROOT = path.resolve(process.cwd(), "config");

const readJson = <T>(file: string): T => {
  const raw = fs.readFileSync(path.join(CONFIG_ROOT, file), "utf-8");
  return JSON.parse(raw) as T;
};

interface BrandProfilesFile {
  default: string;
  profiles: Record<string, string>;
}
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
  /** Bật/tắt điền mục Specifics (map SHEIN attributes → dropdown 4Seller). Mặc định false. */
  fillSpecifics?: boolean;
  /** Color showcase: chèn 1 ảnh collage màu (per-shop, chống trùng) làm ảnh Main. Mặc định tắt. */
  colorShowcase?: { enabled: boolean; style?: "A" | "B" | "C" };
}
interface SizeMapFile {
  map: Record<string, string>;
}
export interface SpecificsMapFile {
  // 1 key SHEIN có thể trỏ 1 hoặc NHIỀU field 4Seller (thử lần lượt, field nào có + khớp thì điền).
  keyMap: Record<string, string | string[]>;
  valueSynonyms: Record<string, string>;
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
interface CategoriesFile {
  categories: string[];
}

let _brandProfiles: BrandProfilesFile | null = null;
let _pricing: PricingFile | null = null;
let _worker: WorkerFile | null = null;
let _sizeMap: SizeMapFile | null = null;
let _categories: CategoriesFile | null = null;
let _specificsMap: SpecificsMapFile | null = null;

export const brandProfiles = (): BrandProfilesFile =>
  (_brandProfiles ??= readJson<BrandProfilesFile>("brand-profiles.json"));

export const pricing = (): PricingFile =>
  (_pricing ??= readJson<PricingFile>("pricing.json"));

export const workerConfig = (): WorkerFile =>
  (_worker ??= readJson<WorkerFile>("worker.json"));

export const sizeMap = (): Record<string, string> =>
  (_sizeMap ??= readJson<SizeMapFile>("size-map.json")).map;

export const tiktokCategories = (): string[] =>
  (_categories ??= readJson<CategoriesFile>("tiktok-categories.json")).categories;

export const specificsMap = (): SpecificsMapFile =>
  (_specificsMap ??= readJson<SpecificsMapFile>("specifics-map.json"));

let _publish: PublishFile | null = null;
export const publishConfig = (): PublishFile =>
  (_publish ??= readJson<PublishFile>("publish.json"));

/** Resolve brand cho 1 profile shop. Fallback về default nếu chưa định nghĩa. */
export const resolveBrand = (profile: string): string => {
  const cfg = brandProfiles();
  return cfg.profiles[profile] ?? cfg.default;
};

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
  _brandProfiles = null;
  _pricing = null;
  _worker = null;
  _sizeMap = null;
  _categories = null;
  _specificsMap = null;
  _publish = null;
};
