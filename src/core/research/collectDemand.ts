/**
 * runDemandCollection — thu demand TikTok US từ Kalodata (qua Kiki) → lưu Signal Store.
 * Dùng cho API /research/collect-demand + cron. demandFit của dailyResearch sẽ đọc
 * snapshot này (kalodataStore.latestDay()).
 */
import { collectKalodata } from "../../services/kalodata/client";
import { kalodataStore } from "../../state/kalodataStore";
import { readKikiConfig } from "../../services/kiki/config";
import { today } from "../../state/researchStore";

export interface DemandResult {
  day: string;
  categories: number;
  products: number;
  startDate: string;
  endDate: string;
  topRising: { name: string; level: string; growth: number | null }[];
}

export async function runDemandCollection(opts: {
  profileId?: string;
  categoryPages?: number;
  productPages?: number;
  perCategoryTop?: number;
  onLog?: (m: string) => void;
} = {}): Promise<DemandResult> {
  const log = opts.onLog ?? (() => {});
  const profileId = opts.profileId || readKikiConfig().profiles[0]?.id;
  if (!profileId) throw new Error("Chưa có Kiki profile (config/kiki.json) để thu Kalodata");

  const r = await collectKalodata({
    profileId,
    categoryPages: opts.categoryPages ?? 8,  // kéo sâu để bắt L2/L3 thời trang (swim/dress/sport…)
    productPages: opts.productPages ?? 4,
    perCategoryTop: opts.perCategoryTop ?? 24, // pull product top 24 fashion category → drill-down
    onLog: log,
  });

  const day = today();
  kalodataStore.saveCategories(day, r.categories);
  kalodataStore.saveProducts(day, r.products);
  kalodataStore.saveCategoryProducts(day, r.categoryProducts);

  const topRising = [...r.categories]
    .filter((c) => c.growthRate != null)
    .sort((a, b) => (b.growthRate ?? 0) - (a.growthRate ?? 0))
    .slice(0, 8)
    .map((c) => ({ name: c.name, level: c.level, growth: c.growthRate }));

  log(`✅ Demand ${day}: ${r.categories.length} category · ${r.products.length} product.`);
  return { day, categories: r.categories.length, products: r.products.length, startDate: r.startDate, endDate: r.endDate, topRising };
}
