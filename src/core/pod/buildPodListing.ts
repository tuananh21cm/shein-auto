import fs from "fs-extra";
import path from "path";
import { config } from "../../config";
import { podConfig } from "../../config/appConfig";
import { uploadToImgbbCached } from "../../utils/imgbbCache";

const IMG_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * Folder material đang dùng: pod.json.materialDir → env POD_MATERIAL_DIR → mặc định data/pod-materials.
 * Dùng chung cho build listing + endpoint quản lý material trên UI.
 */
export function resolvePodMaterialDir(): string {
  const fromCfg = (podConfig().materialDir || "").trim();
  if (fromCfg) return path.normalize(fromCfg);
  if (config.podMaterialDir) return config.podMaterialDir;
  return path.resolve(process.cwd(), "data", "pod-materials");
}

/** Fisher–Yates shuffle (copy, không mutate input). */
const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export interface PodListingJson {
  product_name: string;
  category: string;
  brand_name?: string;
  listing_variations: { colors: string[]; sizes: string[] };
  sizes_available: string[];
  variant_price: Record<string, string>[];
  variant_images: Record<string, string[]>[];
  product_images: string[];
  available_matrix: Record<string, string[]>;
  attributes: Record<string, string>;
  size_chart: unknown;
  measure_guide: unknown;
  market: string;
  scraped_at: string;
  _pod: true;
  _podPriceFinal: true;
  _podDescriptionTemplate: string;
  _podSizeSurcharge: Record<string, number>;
}

/**
 * Build JSON listing POD từ 1 ảnh thiết kế + template config/pod.json.
 *  - Host ảnh design + vài ảnh material random lên imgbb (pipeline upload chỉ tải URL).
 *  - Random N màu từ palette; MỌI màu dùng CHUNG 1 ảnh design (cờ _pod tắt dedup ở preprocess).
 *  - Giá = finalPrice cố định (cờ _podPriceFinal bỏ qua multiplier global khi điền bảng).
 * Throw nếu không host được ảnh design (POD bắt buộc URL public).
 */
export async function buildPodListing(opts: {
  designPath: string;
  title: string;
}): Promise<PodListingJson> {
  const { designPath, title } = opts;
  const pod = podConfig();

  // 1. Host ảnh design (bắt buộc).
  const designUrl = await uploadToImgbbCached(designPath);
  if (!designUrl) {
    throw new Error(`Không host được ảnh design lên imgbb (kiểm tra IMGBB_API_KEY): ${path.basename(designPath)}`);
  }

  // 2. Ảnh phụ: bốc NGẪU NHIÊN đúng `auxImages` ảnh material → host. Bỏ ảnh fail.
  const materialUrls: string[] = [];
  const want = pod.auxImages ?? pod.materialsPick?.max ?? 6;
  const matDir = resolvePodMaterialDir();
  if (want > 0 && (await fs.pathExists(matDir))) {
    const all = (await fs.readdir(matDir)).filter((f) => IMG_EXT.test(f));
    const pickN = Math.min(all.length, want);
    if (pickN < want) console.warn(`⚠️ POD: chỉ có ${all.length} ảnh material, cần ${want} ảnh phụ.`);
    for (const f of shuffle(all).slice(0, pickN)) {
      const url = await uploadToImgbbCached(path.join(matDir, f));
      if (url) materialUrls.push(url);
    }
  }

  // 3. Màu = TOÀN BỘ palette (cố định, KHÔNG random) — muốn đổi thì sửa palette trong config.
  const colors = [...pod.palette];

  // 4. Compose. Mọi màu cùng designUrl; giá đều = finalPrice.
  const price = `$${String(pod.finalPrice).replace(/^\$/, "")}`;
  const variant_price = colors.map((c) => ({ [c]: price }));
  const variant_images = colors.map((c) => ({ [c]: [designUrl] }));
  const available_matrix: Record<string, string[]> = {};
  for (const c of colors) available_matrix[c] = [...pod.sizes];

  // Random 1 ngách trong danh sách (mặc định fallback nếu config rỗng).
  const cats = pod.categories?.length ? pod.categories : ["Womenswear & Underwear / Women's Tops / Women's T-shirts"];
  const category = cats[Math.floor(Math.random() * cats.length)];

  return {
    product_name: title,
    category,
    brand_name: pod.brand_name || undefined,
    listing_variations: { colors, sizes: [...pod.sizes] },
    sizes_available: [...pod.sizes],
    variant_price,
    variant_images,
    product_images: [designUrl, ...materialUrls],
    available_matrix,
    attributes: { ...pod.attributes },
    size_chart: pod.size_chart,
    measure_guide: pod.measure_guide,
    market: "POD",
    scraped_at: new Date().toISOString(),
    _pod: true,
    _podPriceFinal: true,
    _podDescriptionTemplate: pod.descriptionTemplate || "",
    _podSizeSurcharge: pod.sizeSurcharge || {},
  };
}
