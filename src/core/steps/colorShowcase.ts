import fs from "fs";
import path from "path";
import crypto from "crypto";
import { renderHtmlToImage, fetchAsDataUri } from "./htmlToImage";

export type ColorShowcaseStyle = "A" | "B" | "C";

const orig = (u: string) => (u || "").replace(/^\/\//, "https://");
const CSS = `* {margin:0;padding:0;box-sizing:border-box;} body{width:900px;height:1200px;font-family:'Helvetica Neue',Arial,sans-serif;}`;

/** Build HTML 1 trong 3 style ảnh "nhiều màu" (900×1200, 3:4). */
function showcaseHtml(
  main: string,
  variants: { color: string; img: string }[],
  style: ColorShowcaseStyle
): string {
  const N = variants.length;
  if (style === "A") {
    const cols = N <= 9 ? 3 : 4;
    const shown = variants.slice(0, cols * 4);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}
.wrap{width:900px;height:1200px;background:#fff;display:flex;flex-direction:column;}
.hd{background:#111;color:#fff;text-align:center;padding:26px;}
.hd h1{font-size:40px;font-weight:800;letter-spacing:3px;}
.hd p{font-size:16px;color:#ffd24d;letter-spacing:4px;margin-top:6px;text-transform:uppercase;}
.grid{flex:1;display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px;padding:18px;}
.cell{position:relative;border-radius:8px;overflow:hidden;background:#f3f3f3;}
.cell img{width:100%;height:100%;object-fit:cover;}
.cell span{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);color:#fff;font-size:13px;text-align:center;padding:4px;}
</style></head><body><div class="wrap">
<div class="hd"><h1>${N} COLORS AVAILABLE</h1><p>Pick your favorite shade</p></div>
<div class="grid">${shown.map((v) => `<div class="cell"><img src="${v.img}"><span>${v.color}</span></div>`).join("")}</div>
</div></body></html>`;
  }
  if (style === "B") {
    // Main full-bleed + cột swatch NHỎ bên PHẢI, căn giữa dọc (tránh tag freeship/promotion
    // ở đáy ảnh trên TikTok US). Viền trắng + ring tối + shadow → nổi trên nền sáng LẪN tối.
    const shown = variants.slice(0, 6);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}
.wrap{width:900px;height:1200px;position:relative;background:#eee;}
.wrap>img{width:100%;height:100%;object-fit:cover;}
.col{position:absolute;top:50%;right:22px;transform:translateY(-50%);display:flex;flex-direction:column;gap:13px;}
.sw{width:92px;height:118px;border-radius:11px;overflow:hidden;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 3px 9px rgba(0,0,0,.45);}
.sw img{width:100%;height:100%;object-fit:cover;display:block;}
.more{width:92px;height:92px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);color:#fff;font-size:26px;font-weight:800;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 3px 9px rgba(0,0,0,.45);}
</style></head><body><div class="wrap">
<img src="${main}">
<div class="col">${shown.map((v) => `<div class="sw"><img src="${v.img}"></div>`).join("")}${N > 6 ? `<div class="more">+${N - 6}</div>` : ""}</div>
</div></body></html>`;
  }
  // C
  const shown = variants.slice(0, 6);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}
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
<div class="row">${shown.map((v) => `<div class="sw"><img src="${v.img}"></div>`).join("")}${N > 6 ? `<div class="more">+${N - 6}</div>` : ""}</div></div>
</div></body></html>`;
}

/** Hash chuỗi → uint (chọn ảnh nền xoay theo shop, ổn định). */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Tạo ảnh "nhiều màu" từ product_images + variant_images → file PNG tạm (caller xoá sau khi upload).
 * Trả null nếu < 2 màu (không cần). Style A/B/C.
 *
 * opts.bgSeed: nếu có → ẢNH NỀN (style B/C) chọn theo seed (xoay màu theo shop) thay vì
 * dùng chung productImages[0] → cùng 1 sp list ở shop khác nhau ra ảnh main NỀN KHÁC màu.
 */
export async function buildColorShowcaseImageFile(
  productImages: string[] | undefined,
  variantImages: Record<string, string[]>[] | undefined,
  style: ColorShowcaseStyle = "C",
  opts?: { bgSeed?: string }
): Promise<string | null> {
  const mainUrl = orig(productImages?.[0] || "");
  const variantUrls = (variantImages || [])
    .map((o) => {
      const c = Object.keys(o)[0];
      return { color: c, img: orig(o[c]?.[0] || "") };
    })
    .filter((v) => v.img);
  if (variantUrls.length < 2) return null;

  // Tải ảnh SHEIN → base64 data URI. SHEIN chặn hotlink từ Chrome headless → URL remote không load
  // (ảnh showcase trắng). Nhúng base64 → render khỏi cần mạng.
  const variants = (
    await Promise.all(
      variantUrls.map(async (v) => ({ color: v.color, img: (await fetchAsDataUri(v.img)) || "" }))
    )
  ).filter((v) => v.img);
  if (variants.length < 2) {
    console.warn(`⚠️ color showcase: chỉ tải được ${variants.length}/${variantUrls.length} ảnh → bỏ qua`);
    return null;
  }

  // Ảnh NỀN: có bgSeed → chọn hero của 1 màu theo shop (xoay, không dùng chung productImages[0]).
  let main = "";
  if (opts?.bgSeed) {
    const idx = hashStr(opts.bgSeed) % variants.length;
    main = variants[idx].img;
    console.log(`🎨 Color showcase nền theo shop: màu "${variants[idx].color}" (idx ${idx}/${variants.length})`);
  } else {
    main = mainUrl ? (await fetchAsDataUri(mainUrl)) || variants[0].img : variants[0].img;
  }
  if (!main && style !== "A") return null;

  const out = path.join(__dirname, `temp_colors_${crypto.randomBytes(6).toString("hex")}.png`);
  await renderHtmlToImage({
    output: out,
    html: showcaseHtml(main, variants, style),
    viewport: { width: 900, height: 1200 },
  });
  return out;
}
