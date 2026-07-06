import path from "path";
import crypto from "crypto";
import { renderHtmlToImage, fetchImagesAsDataUris } from "./htmlToImage";

export type BannerStyle = "collage" | "feature";

const orig = (u: string) => (u || "").replace(/^\/\//, "https://");

/**
 * Lấy ảnh ĐA MÀU + ĐA GÓC CHỤP từ variant_images. Diagonal pick: màu thứ c ở vòng r lấy ảnh
 * index (r+c) → mỗi màu 1 góc khác nhau (front/back/detail), tránh 4 ảnh "front" trùng pose.
 * → 4 ảnh đầu (collage) = 4 màu KHÁC + 4 góc KHÁC.
 */
export function diverseImagesFromVariants(
  variantImages: Record<string, string[]>[] | undefined
): string[] {
  const byColor: string[][] = [];
  for (const o of variantImages || []) {
    const c = Object.keys(o)[0];
    const imgs = (o?.[c] || []).map(orig).filter(Boolean);
    if (imgs.length) byColor.push(imgs);
  }
  if (!byColor.length) return [];
  const out: string[] = [];
  const maxLen = byColor.reduce((m, a) => Math.max(m, a.length), 0);
  for (let r = 0; r < maxLen; r++) {
    for (let c = 0; c < byColor.length; c++) {
      const arr = byColor[c];
      const img = arr[(r + c) % arr.length]; // lệch index theo màu → đa góc chụp
      if (img && !out.includes(img)) out.push(img);
    }
  }
  return out;
}
// Khổ NGANG 1200×750 (16:10) — tham chiếu banner mô tả TikTok Shop.
const CSS = `*{margin:0;padding:0;box-sizing:border-box;}body{width:1200px;height:750px;font-family:'Helvetica Neue',Arial,sans-serif;}`;
const ACCENT = "#b8860b"; // gold tinh tế

function bannerHtml(
  imgs: string[],
  style: BannerStyle,
  title: string,
  tagline: string,
  highlights: string[]
): string {
  const hl = (highlights || []).slice(0, 4);

  if (style === "feature") {
    // Hero trái + panel phải: tagline → title (serif) → 4 highlight checkmark → 2 ảnh nhỏ.
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}
.wrap{width:1200px;height:750px;display:flex;background:linear-gradient(135deg,#f8f4ee,#ece2d3);}
.hero{width:500px;height:750px;overflow:hidden;}
.hero img{width:100%;height:100%;object-fit:cover;}
.panel{flex:1;padding:48px 54px;display:flex;flex-direction:column;justify-content:center;}
.tag{font-size:15px;letter-spacing:5px;color:${ACCENT};font-weight:700;text-transform:uppercase;margin-bottom:12px;}
.panel h1{font-family:Georgia,'Times New Roman',serif;font-size:44px;font-weight:800;color:#2a2723;line-height:1.1;}
.line{width:68px;height:3px;background:${ACCENT};margin:18px 0 24px;}
.hl{list-style:none;}
.hl li{display:flex;align-items:center;gap:12px;font-size:20px;color:#3a3631;margin-bottom:15px;font-weight:600;}
.ck{width:27px;height:27px;border-radius:50%;background:${ACCENT};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
.mini{display:flex;gap:11px;margin-top:22px;}
.mini img{width:92px;height:116px;object-fit:cover;border-radius:8px;border:2px solid #fff;box-shadow:0 2px 7px rgba(0,0,0,.18);}
</style></head><body><div class="wrap">
<div class="hero"><img src="${imgs[1] || imgs[0]}"></div>
<div class="panel">
  <div class="tag">${tagline}</div>
  <h1>${title}</h1><div class="line"></div>
  <ul class="hl">${hl.map((h) => `<li><span class="ck">✓</span>${h}</li>`).join("")}</ul>
  <div class="mini">${imgs.slice(2, 5).map((u) => `<img src="${u}">`).join("")}</div>
</div></div></body></html>`;
  }

  // collage: title (serif) trên + hàng 4 ảnh + chip highlight dưới.
  const four = imgs.slice(0, 4);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}
.wrap{width:1200px;height:750px;background:#f5f1ea;display:flex;flex-direction:column;}
.top{text-align:center;padding:24px 20px 18px;}
.top h1{font-family:Georgia,'Times New Roman',serif;font-size:40px;font-weight:800;color:#2a2723;letter-spacing:1px;}
.top p{font-size:15px;color:${ACCENT};letter-spacing:4px;margin-top:6px;text-transform:uppercase;}
.row{flex:1;display:flex;gap:10px;padding:0 22px;min-height:0;}
.c{flex:1;overflow:hidden;border-radius:8px;}
.c img{width:100%;height:100%;object-fit:cover;}
.tags{display:flex;gap:13px;justify-content:center;padding:20px;flex-wrap:wrap;}
.tags span{font-size:16px;color:#3a3631;font-weight:600;background:#fff;border:1px solid #e3dccc;padding:8px 18px;border-radius:30px;}
.tags b{color:${ACCENT};margin-right:6px;}
</style></head><body><div class="wrap">
<div class="top"><h1>${title}</h1><p>${tagline}</p></div>
<div class="row">${four.map((u) => `<div class="c"><img src="${u}"></div>`).join("")}</div>
<div class="tags">${hl.map((h) => `<span><b>✓</b>${h}</span>`).join("")}</div>
</div></body></html>`;
}

/**
 * Banner "trust badges" tĩnh (1200×280) chèn CUỐI mô tả: shipping / quality / returns.
 * KHÔNG phụ thuộc sản phẩm/shop → nội dung cố định → PNG deterministic → upload qua
 * uploadToImgbbCached là cache hit từ lần 2 (không tốn quota imgbb).
 * Caller xoá file sau khi upload.
 */
export async function buildTrustBannerFile(): Promise<string | null> {
  const badges = [
    { icon: "🚚", label: "Fast US Shipping", sub: "Ships within 1-3 days" },
    { icon: "✓", label: "Quality Checked", sub: "Inspected before dispatch" },
    { icon: "↺", label: "Easy Returns", sub: "Hassle-free within 30 days" },
    { icon: "🔒", label: "Secure Checkout", sub: "TikTok Shop protected" },
  ];
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}body{width:1200px;height:280px;font-family:'Helvetica Neue',Arial,sans-serif;}
.wrap{width:1200px;height:280px;background:linear-gradient(135deg,#f8f4ee,#ece2d3);display:flex;align-items:center;justify-content:center;gap:26px;padding:0 40px;}
.card{flex:1;background:#fff;border:1px solid #e3dccc;border-radius:12px;padding:26px 18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.ic{width:52px;height:52px;border-radius:50%;background:${ACCENT};color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 14px;}
.lb{font-size:19px;font-weight:800;color:#2a2723;margin-bottom:6px;}
.sub{font-size:14px;color:#8a8272;}
</style></head><body><div class="wrap">
${badges
    .map(
      (bd) =>
        `<div class="card"><div class="ic">${bd.icon}</div><div class="lb">${bd.label}</div><div class="sub">${bd.sub}</div></div>`
    )
    .join("")}
</div></body></html>`;
  const out = path.join(__dirname, `temp_trust_${crypto.randomBytes(6).toString("hex")}.png`);
  await renderHtmlToImage({
    output: out,
    html,
    viewport: { width: 1200, height: 280 },
  });
  return out;
}

/**
 * Render 1 banner marketing NGANG (1200×750) từ ảnh SHEIN + text highlight → file PNG tạm.
 * Trả null nếu < 2 ảnh. Caller xoá file sau khi upload.
 */
export async function buildBannerFile(
  productImages: string[] | undefined,
  style: BannerStyle,
  title: string,
  tagline: string,
  highlights: string[] = []
): Promise<string | null> {
  const imgs = (productImages || []).map(orig).filter(Boolean);
  if (imgs.length < 2) return null;
  // Tải ảnh SHEIN → base64 data URI. SHEIN chặn hotlink từ Chrome headless → KHÔNG để URL remote
  // trong HTML (ảnh không load → banner trắng/timeout). Nhúng base64 → render khỏi cần mạng.
  const dataImgs = await fetchImagesAsDataUris(imgs);
  if (dataImgs.length < 2) {
    console.warn(`⚠️ banner ${style}: chỉ tải được ${dataImgs.length}/${imgs.length} ảnh → bỏ qua`);
    return null;
  }
  const out = path.join(__dirname, `temp_banner_${crypto.randomBytes(6).toString("hex")}.png`);
  await renderHtmlToImage({
    output: out,
    html: bannerHtml(dataImgs, style, title, tagline, highlights),
    viewport: { width: 1200, height: 750 },
  });
  return out;
}
