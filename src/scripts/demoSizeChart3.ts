/** Test layout 3 mảnh — kiểm tra tràn/cắt. Chạy: npx tsx src/scripts/demoSizeChart3.ts */
import path from "path";
import nodeHtmlToImage from "node-html-to-image";
import { generateSizeChartHtml, SizeChartSection } from "../core/steps/handleSizeChart";

const mk = (name: string, third: string): SizeChartSection => ({
  name,
  headers: ["US", "Size", third, "Hip"],
  data: [
    { US: "4", Size: "S", [third]: "26-38.6", Hip: "31.1" },
    { US: "6", Size: "M", [third]: "27.6-40.2", Hip: "32.7" },
    { US: "8/10", Size: "L", [third]: "29.9-42.5", Hip: "35" },
    { US: "12", Size: "XL", [third]: "32.3-44.9", Hip: "37.4" },
  ],
});

const sections = [mk("Pants", "Waist"), mk("Bikini Tops", "Bust"), mk("Cover Up", "Length")];

(async () => {
  const out = path.join(__dirname, "../../data/demo-3pieces.png");
  await nodeHtmlToImage({
    output: out,
    html: generateSizeChartHtml(sections, "inch"),
    puppeteerArgs: { defaultViewport: { width: 900, height: 900 } },
  });
  console.log("✅ done", out);
})();
