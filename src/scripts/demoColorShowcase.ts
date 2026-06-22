/**
 * Demo 3 style ảnh "nhiều màu" để khách biết sản phẩm có nhiều màu.
 * Chạy: npx tsx src/scripts/demoColorShowcase.ts <path.json>
 * Output: data/demo-colors-A|B|C.png  (900×1200, 3:4)
 */
import fs from "fs";
import path from "path";
import nodeHtmlToImage from "node-html-to-image";

const file = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const orig = (u: string) => (u || "").replace(/^\/\//, "https://");
const main = orig(j.product_images?.[0] || "");
const variants: { color: string; img: string }[] = (j.variant_images || [])
  .map((o: any) => {
    const c = Object.keys(o)[0];
    return { color: c, img: orig(o[c]?.[0] || "") };
  })
  .filter((v: any) => v.img);
const N = variants.length;

const render = (name: string, html: string) =>
  nodeHtmlToImage({
    output: path.join(__dirname, `../../data/${name}`),
    html,
    puppeteerArgs: { defaultViewport: { width: 900, height: 1200 } },
  }).then(() => console.log("✅", name));

const css = `* {margin:0;padding:0;box-sizing:border-box;} body{width:900px;height:1200px;font-family:'Helvetica Neue',Arial,sans-serif;}`;

// ===== A. Collage grid (ảnh riêng) =====
const gridCols = N <= 9 ? 3 : 4;
const shownA = variants.slice(0, gridCols * 4); // tối đa 16
const A = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}
.wrap{width:900px;height:1200px;background:#fff;display:flex;flex-direction:column;}
.hd{background:#111;color:#fff;text-align:center;padding:26px;}
.hd h1{font-size:40px;font-weight:800;letter-spacing:3px;}
.hd p{font-size:16px;color:#ffd24d;letter-spacing:4px;margin-top:6px;text-transform:uppercase;}
.grid{flex:1;display:grid;grid-template-columns:repeat(${gridCols},1fr);gap:10px;padding:18px;}
.cell{position:relative;border-radius:8px;overflow:hidden;background:#f3f3f3;}
.cell img{width:100%;height:100%;object-fit:cover;}
.cell span{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);color:#fff;font-size:13px;text-align:center;padding:4px;}
</style></head><body><div class="wrap">
<div class="hd"><h1>${N} COLORS AVAILABLE</h1><p>Pick your favorite shade</p></div>
<div class="grid">${shownA.map(v=>`<div class="cell"><img src="${v.img}"><span>${v.color}</span></div>`).join("")}</div>
</div></body></html>`;

// ===== B. Main + dải swatch dưới =====
const shownB = variants.slice(0, 8);
const B = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}
.wrap{width:900px;height:1200px;background:#fff;display:flex;flex-direction:column;}
.main{flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#eee;}
.main img{width:100%;height:100%;object-fit:cover;}
.strip{height:230px;background:#fff;padding:16px 18px;display:flex;flex-direction:column;}
.strip .t{font-size:22px;font-weight:800;text-align:center;margin-bottom:12px;}
.strip .t b{color:#e0115f;}
.row{display:flex;gap:10px;justify-content:center;}
.sw{width:90px;height:120px;border-radius:8px;overflow:hidden;border:2px solid #eee;}
.sw img{width:100%;height:100%;object-fit:cover;}
.more{display:flex;align-items:center;justify-content:center;width:90px;height:120px;border-radius:8px;background:#111;color:#fff;font-size:20px;font-weight:800;}
</style></head><body><div class="wrap">
<div class="main"><img src="${main}"></div>
<div class="strip"><div class="t">Available in <b>${N} Colors</b></div>
<div class="row">${shownB.map(v=>`<div class="sw"><img src="${v.img}"></div>`).join("")}${N>8?`<div class="more">+${N-8}</div>`:""}</div></div>
</div></body></html>`;

// ===== C. Main + badge góc + mini swatch =====
const shownC = variants.slice(0, 6);
const C = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}
.wrap{width:900px;height:1200px;position:relative;background:#eee;}
.wrap>img{width:100%;height:100%;object-fit:cover;}
.badge{position:absolute;top:24px;right:24px;background:#e0115f;color:#fff;font-size:24px;font-weight:800;padding:10px 18px;border-radius:30px;box-shadow:0 4px 14px rgba(0,0,0,.3);}
.bar{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.75));padding:40px 20px 22px;}
.bar .t{color:#fff;font-size:20px;font-weight:700;margin-bottom:10px;text-align:center;}
.bar .row{display:flex;gap:8px;justify-content:center;}
.bar .sw{width:70px;height:70px;border-radius:50%;overflow:hidden;border:3px solid #fff;}
.bar .sw img{width:100%;height:100%;object-fit:cover;}
.bar .more{width:70px;height:70px;border-radius:50%;background:rgba(255,255,255,.25);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;border:3px solid #fff;}
</style></head><body><div class="wrap">
<img src="${main}">
<div class="badge">🎨 ${N} Colors</div>
<div class="bar"><div class="t">More colors available</div>
<div class="row">${shownC.map(v=>`<div class="sw"><img src="${v.img}"></div>`).join("")}${N>6?`<div class="more">+${N-6}</div>`:""}</div></div>
</div></body></html>`;

(async () => {
  console.log(`Product: ${j.product_name?.slice(0, 50)} | ${N} màu`);
  await render("demo-colors-A.png", A);
  await render("demo-colors-B.png", B);
  await render("demo-colors-C.png", C);
})();
