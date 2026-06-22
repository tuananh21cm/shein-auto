/**
 * Demo ảnh GỘP "Size Guide" (bảng size + How To Measure) cho 1/2/3 piece.
 * Chạy: npx tsx src/scripts/demoSizeGuide.ts
 * Output: data/demo-guide-1piece.png, -2piece.png, -3piece.png
 */
import path from "path";
import nodeHtmlToImage from "node-html-to-image";
import { generateSizeGuideImageHtml, SizeChartSection, MeasureGuide } from "../core/steps/handleSizeChart";
import { processMeasureGuideImage } from "../core/steps/measureGuideImage";

const RAW_IMG =
  "https://img.ltwebstatic.com/images3_pi/2021/11/30/1638225033b01c5e87ff2ae468d326bf85b43f5af3.jpg";

const measureItems = [
  { index: "1", name: "Bust", desc: "Measure from the stitches below the armpits on one side to another." },
  { index: "2", name: "Waist", desc: "Measure straight across the narrowest waist line from edge to edge." },
  { index: "3", name: "Hips", desc: "Measure straight across the widest hip line from edge to edge." },
  { index: "4", name: "Length", desc: "Measure from where the shoulder seam meets the collar to the hem." },
];

const pants: SizeChartSection = {
  name: "Pants",
  headers: ["US", "Size", "Waist Size", "Hip Size", "Length"],
  data: [
    { US: "4", Size: "S", "Waist Size": "26-38.6", "Hip Size": "31.1", Length: "8.7" },
    { US: "6", Size: "M", "Waist Size": "27.6-40.2", "Hip Size": "32.7", Length: "8.8" },
    { US: "8/10", Size: "L", "Waist Size": "29.9-42.5", "Hip Size": "35", Length: "9.1" },
    { US: "12", Size: "XL", "Waist Size": "32.3-44.9", "Hip Size": "37.4", Length: "9.3" },
  ],
};
const tops: SizeChartSection = {
  name: "Bikini Tops",
  headers: ["US", "Size", "Bust Size", "Underbust"],
  data: [
    { US: "4", Size: "S", "Bust Size": "29.9-33.1", Underbust: "23.6-27.6" },
    { US: "6", Size: "M", "Bust Size": "31.5-34.6", Underbust: "25.2-29.1" },
    { US: "8/10", Size: "L", "Bust Size": "33.1-36.2", Underbust: "26.8-30.7" },
    { US: "12", Size: "XL", "Bust Size": "34.6-37.8", Underbust: "28.3-32.3" },
  ],
};
const coverUp: SizeChartSection = {
  name: "Cover Up",
  headers: ["US", "Size", "Length", "Sleeve"],
  data: [
    { US: "4", Size: "S", Length: "33.1", Sleeve: "7.1" },
    { US: "6", Size: "M", Length: "33.9", Sleeve: "7.5" },
    { US: "8/10", Size: "L", Length: "34.6", Sleeve: "7.9" },
    { US: "12", Size: "XL", Length: "35.4", Sleeve: "8.3" },
  ],
};

const render = async (file: string, sections: SizeChartSection[], mg: MeasureGuide) => {
  const out = path.join(__dirname, `../../data/${file}`);
  await nodeHtmlToImage({
    output: out,
    html: generateSizeGuideImageHtml(sections, mg, "inch"),
    puppeteerArgs: { defaultViewport: { width: 900, height: 1200 } },
  });
  console.log("✅", out);
};

(async () => {
  const image = await processMeasureGuideImage(RAW_IMG); // che watermark SHEIN
  const mg: MeasureGuide = { items: measureItems, image };
  await render("demo-guide-1piece.png", [{ ...pants, name: undefined }], mg);
  await render("demo-guide-2piece.png", [pants, tops], mg);
  await render("demo-guide-3piece.png", [pants, tops, coverUp], mg);
})();
