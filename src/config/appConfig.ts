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
  offset: number;
  divisor: number;
  defaultQty: number;
  defaultWeight: string;
  defaultDimensions: { length: string; width: string; height: string };
}
interface WorkerFile {
  concurrency: number;
  headless: boolean;
  fileRouterCron: string;
  queueManagerCron: string;
  imageUploadWaitPerImageMs: number;
  imageUploadMaxImages: number;
  descriptionImagesCount: number;
  descriptionMaxAttributes: number;
}
interface SizeMapFile {
  map: Record<string, string>;
}
interface CategoriesFile {
  categories: string[];
}

let _brandProfiles: BrandProfilesFile | null = null;
let _pricing: PricingFile | null = null;
let _worker: WorkerFile | null = null;
let _sizeMap: SizeMapFile | null = null;
let _categories: CategoriesFile | null = null;

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

/** Resolve brand cho 1 profile shop. Fallback về default nếu chưa định nghĩa. */
export const resolveBrand = (profile: string): string => {
  const cfg = brandProfiles();
  return cfg.profiles[profile] ?? cfg.default;
};

/** Tính giá bán cuối cùng từ giá gốc theo công thức trong pricing.json. */
export const computeFinalPrice = (originalPrice: number): number => {
  const { offset, divisor } = pricing();
  return (originalPrice + offset) / divisor;
};

/** Force reload config từ disk (dùng cho Settings UI sau này). */
export const reloadAppConfig = (): void => {
  _brandProfiles = null;
  _pricing = null;
  _worker = null;
  _sizeMap = null;
  _categories = null;
};
