/**
 * Preview mô tả listing có khối "How To Measure" (data thật từ sản phẩm bikini).
 * Chạy: npx tsx src/scripts/demoMeasureGuide.ts → data/demo-description.png
 * Mô phỏng đúng HTML sẽ dán vào CKEditor của 4Seller (wrapper font Arial).
 */
import path from "path";
import nodeHtmlToImage from "node-html-to-image";
import { generateDescriptionHtml, generateMeasureGuideHtml } from "../core/steps/fillDescription";
import { processMeasureGuideImage } from "../core/steps/measureGuideImage";

const attributes = {
  "Material": "95% Polyester, 5% Elastane",
  "Style": "Beach, Vacation, Casual",
  "Pattern Type": "Plain",
  "Neckline": "Halter",
};

const rawImage =
  "https://img.ltwebstatic.com/images3_pi/2021/11/30/1638225033b01c5e87ff2ae468d326bf85b43f5af3.jpg";
const items = [
  { index: "1", name: "Bust", desc: "Measure from the stitches below the armpits on one side to another." },
  { index: "2", name: "Waist", desc: "Measure straight across the narrowest waist line from edge to edge." },
  { index: "3", name: "Hips", desc: "Measure straight across the widest hip line from edge to edge." },
  { index: "4", name: "Length", desc: "Measure from where the shoulder seam meets the collar to the hem." },
];

// Giống fillDescription: wrap div font Arial. Thêm khung preview 600px nền trắng.
const wrap = (descHtml: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;background:#e9e9e9;padding:24px;font-family:Arial,sans-serif;}
  .desc{width:600px;background:#fff;padding:20px 24px;border:1px solid #ddd;border-radius:8px;color:#222;line-height:1.55;}
  .desc p{margin:0 0 8px;font-size:14px;}
  .desc figure.image{margin:12px 0;}
  .desc img{max-width:100%;height:auto;display:block;border:1px solid #eee;border-radius:6px;}
</style></head><body>
  <div class="desc"><div style="font-family: Arial;">${descHtml}</div></div>
</body></html>`;

(async () => {
  const image = await processMeasureGuideImage(rawImage); // che watermark SHEIN
  const descHtml =
    generateDescriptionHtml("Sirith Red Summer 2-Piece Swimsuit Set", attributes) +
    generateMeasureGuideHtml({ items, image });
  const html = wrap(descHtml);
  const out = path.join(__dirname, "../../data/demo-description.png");
  await nodeHtmlToImage({ output: out, html, puppeteerArgs: { defaultViewport: { width: 700, height: 10 } } });
  console.log("✅ done", out);
})();
