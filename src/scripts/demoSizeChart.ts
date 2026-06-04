/**
 * Demo render ảnh Size Chart bikini 2 mảnh (Pants + Bikini Tops) → 1 ảnh ghép.
 * Chạy: npx tsx src/scripts/demoSizeChart.ts
 * Output: data/demo-size-chart.png
 *
 * Pants: số liệu THẬT lấy từ Product Chart (đơn vị IN) của sản phẩm.
 * Bikini Tops: số liệu MẪU (ảnh gốc bị cắt phần này) — sẽ thay bằng data cào thật.
 */
import path from "path";
import nodeHtmlToImage from "node-html-to-image";
import { generateSizeChartHtml, SizeChartSection } from "../core/steps/handleSizeChart";

const sections: SizeChartSection[] = [
  {
    name: "Pants",
    headers: ["US", "Size", "Waist Size", "Hip Size", "Length"],
    data: [
      { US: "4", Size: "S", "Waist Size": "26-38.6", "Hip Size": "31.1", Length: "8.7" },
      { US: "6", Size: "M", "Waist Size": "27.6-40.2", "Hip Size": "32.7", Length: "8.8" },
      { US: "8/10", Size: "L", "Waist Size": "29.9-42.5", "Hip Size": "35", Length: "9.1" },
      { US: "12", Size: "XL", "Waist Size": "32.3-44.9", "Hip Size": "37.4", Length: "9.3" },
    ],
  },
  {
    name: "Bikini Tops",
    headers: ["US", "Size", "Bust Size", "Underbust"],
    data: [
      { US: "4", Size: "S", "Bust Size": "29.9-33.1", Underbust: "23.6-27.6" },
      { US: "6", Size: "M", "Bust Size": "31.5-34.6", Underbust: "25.2-29.1" },
      { US: "8/10", Size: "L", "Bust Size": "33.1-36.2", Underbust: "26.8-30.7" },
      { US: "12", Size: "XL", "Bust Size": "34.6-37.8", Underbust: "28.3-32.3" },
    ],
  },
];

async function main() {
  const out = path.join(__dirname, "../../data/demo-size-chart.png");
  await nodeHtmlToImage({
    output: out,
    html: generateSizeChartHtml(sections, "inch"),
    puppeteerArgs: { defaultViewport: { width: 900, height: 900 } },
  });
  console.log(`✅ Đã render: ${out}`);
}

main().catch((e) => {
  console.error("❌ Lỗi render demo:", e);
  process.exit(1);
});
