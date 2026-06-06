import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/**
 * Bóc Product Opportunities (trang /product/opportunity) — xác minh discovery 2026-06-06.
 * Endpoint seller_product_opportunity/seller/lead/list trả ~100 cơ hội (keyword/sản phẩm),
 * mỗi cái có search_volume + online_products (số sp cạnh tranh) + category.
 *
 * Surface TOP cơ hội theo tỉ lệ cầu/cung (search cao / cạnh tranh thấp = gap nên lên hàng),
 * lọc search_volume >= 1000 để bỏ nhiễu. AI dùng để gợi ý sản phẩm nên list.
 */
export function extractProductOpportunity(caps: Capture[]): Metric[] {
  const out: Metric[] = [];
  const c = caps.find((x) => /seller_product_opportunity\/seller\/lead\/list/.test(x.url));
  const d = c ? (c.body?.data ?? c.body) : undefined;
  if (!d) return out;

  const items = (Array.isArray(d) ? d : Object.values(d)).filter(
    (v: any) => v && typeof v === "object" && v.lead_name
  );
  if (!items.length) return out;

  const scored = items
    .map((it: any) => ({
      name: String(it.lead_name || ""),
      svNum: toNum(it.search_volume) ?? 0,
      svRaw: String(it.search_volume ?? ""),
      opRaw: String(it.online_products ?? ""),
      opNum: toNum(it.online_products) ?? 0,
      cat: it.level3_cate_name || it.level2_cate_name || it.level1_cate_name || "",
    }))
    .filter((x) => x.name && x.svNum > 0);

  out.push({ key: "opportunities_tracked", valueNum: scored.length, unit: "count" });

  const ranked = scored
    .filter((x) => x.svNum >= 1000)
    .sort((a, b) => b.svNum / Math.max(b.opNum, 1) - a.svNum / Math.max(a.opNum, 1));

  ranked.slice(0, 8).forEach((x, i) => {
    out.push({
      key: `opp_${i + 1}`,
      valueText: `${x.name} — ${x.svRaw} searches / ${x.opRaw} sp (${x.cat})`,
    });
  });

  return out;
}
