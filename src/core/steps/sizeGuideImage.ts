import fs from "fs";
import path from "path";
import crypto from "crypto";
import { promises as fsPromises } from "fs";
import { renderHtmlToImage } from "./htmlToImage";

const THEMES = [
  {
    name: "Ivory Gold",
    bodyBg: "linear-gradient(145deg, #f9f5ee 0%, #f0e9d8 50%, #e8dfc8 100%)",
    cardBorder: "#c9a84c", cardBg: "rgba(255,255,255,0.75)", shadowColor: "rgba(150,120,50,0.12)",
    cornerColor: "#b8923a",
    headerBg: "linear-gradient(135deg, #1c1407 0%, #2d2008 50%, #1c1407 100%)",
    accentColor: "#c9a84c", accentMid: "#f0d080",
    labelColor: "#c9a84c", titleColor: "#f5edd8", unitColor: "#a08840",
    thColor: "#7a5c1e", thBorder: "#b8923a",
    tdColor: "#1a1209", tdFirst: "#8a6820", tdSecond: "#0d0902",
    rowEvenBg: "rgba(201,168,76,0.06)", footerText: "#9a8050", footerDivider: "#c9a84c",
  },
  {
    name: "Rose Blush",
    bodyBg: "linear-gradient(145deg, #fdf5f5 0%, #f5e4e6 50%, #ead0d4 100%)",
    cardBorder: "#c47888", cardBg: "rgba(255,255,255,0.78)", shadowColor: "rgba(160,80,100,0.12)",
    cornerColor: "#b06070",
    headerBg: "linear-gradient(135deg, #1f0810 0%, #350d18 50%, #1f0810 100%)",
    accentColor: "#c47888", accentMid: "#f0a8b8",
    labelColor: "#e0a0b0", titleColor: "#faeaee", unitColor: "#b07080",
    thColor: "#8a3548", thBorder: "#b06070",
    tdColor: "#1a0810", tdFirst: "#9a4560", tdSecond: "#0d0408",
    rowEvenBg: "rgba(196,120,136,0.06)", footerText: "#9a6070", footerDivider: "#c47888",
  },
  {
    name: "Sage Forest",
    bodyBg: "linear-gradient(145deg, #f2f7f0 0%, #e2f0da 50%, #cce4c0 100%)",
    cardBorder: "#6a9860", cardBg: "rgba(255,255,255,0.78)", shadowColor: "rgba(70,120,60,0.12)",
    cornerColor: "#508848",
    headerBg: "linear-gradient(135deg, #081408 0%, #102018 50%, #081408 100%)",
    accentColor: "#6a9860", accentMid: "#9acc88",
    labelColor: "#90c880", titleColor: "#eaf5e8", unitColor: "#5a8850",
    thColor: "#386028", thBorder: "#508848",
    tdColor: "#0a150a", tdFirst: "#488038", tdSecond: "#060d06",
    rowEvenBg: "rgba(106,152,96,0.06)", footerText: "#608060", footerDivider: "#6a9860",
  },
  {
    name: "Ocean Slate",
    bodyBg: "linear-gradient(145deg, #f0f4fa 0%, #dce6f5 50%, #c8d8ee 100%)",
    cardBorder: "#5878c0", cardBg: "rgba(255,255,255,0.80)", shadowColor: "rgba(60,80,160,0.12)",
    cornerColor: "#4060a8",
    headerBg: "linear-gradient(135deg, #080d1e 0%, #0f1830 50%, #080d1e 100%)",
    accentColor: "#5878c0", accentMid: "#88a8e8",
    labelColor: "#90aae0", titleColor: "#eaeefc", unitColor: "#5070b0",
    thColor: "#2a4080", thBorder: "#4060a8",
    tdColor: "#080d20", tdFirst: "#3858a0", tdSecond: "#040810",
    rowEvenBg: "rgba(88,120,192,0.06)", footerText: "#6080a8", footerDivider: "#5878c0",
  },
  {
    name: "Dusty Mauve",
    bodyBg: "linear-gradient(145deg, #f7f3f8 0%, #ecdae8 50%, #dfc8dc 100%)",
    cardBorder: "#9868a8", cardBg: "rgba(255,255,255,0.78)", shadowColor: "rgba(120,80,150,0.12)",
    cornerColor: "#805090",
    headerBg: "linear-gradient(135deg, #180c1e 0%, #281030 50%, #180c1e 100%)",
    accentColor: "#9868a8", accentMid: "#c898d8",
    labelColor: "#c090d8", titleColor: "#f5eefa", unitColor: "#8858a0",
    thColor: "#604878", thBorder: "#805090",
    tdColor: "#120810", tdFirst: "#785898", tdSecond: "#0a040d",
    rowEvenBg: "rgba(152,104,168,0.06)", footerText: "#907898", footerDivider: "#9868a8",
  },
  {
    name: "Terracotta",
    bodyBg: "linear-gradient(145deg, #faf4ee 0%, #f0e0d0 50%, #e4ccb4 100%)",
    cardBorder: "#c07048", cardBg: "rgba(255,255,255,0.78)", shadowColor: "rgba(160,100,60,0.12)",
    cornerColor: "#a85830",
    headerBg: "linear-gradient(135deg, #1e0c08 0%, #321408 50%, #1e0c08 100%)",
    accentColor: "#c07048", accentMid: "#e8a070",
    labelColor: "#e09870", titleColor: "#faeee8", unitColor: "#a86840",
    thColor: "#804020", thBorder: "#a85830",
    tdColor: "#1e0c08", tdFirst: "#a05030", tdSecond: "#100804",
    rowEvenBg: "rgba(192,112,72,0.06)", footerText: "#a07858", footerDivider: "#c07048",
  },
];

export interface SizeChartSection {
  name?: string; // tên mảnh: "Pants", "Bikini Tops"... (undefined nếu chỉ 1 bảng)
  headers: string[];
  data: Record<string, string>[];
}

const isEmptyVal = (v: any): boolean => {
  const s = String(v ?? "").trim();
  return !s || s === "/" || s === "-" || s === "–" || s.toLowerCase() === "n/a";
};

/**
 * Chuẩn hoá sections TRƯỚC khi render — size chart SHEIN (nhất là đồ lót/bra) hay có
 * hàng chục cột làm bảng tràn/đè chữ:
 *  1. Bỏ cột mà MỌI giá trị rỗng ("/", "-", "")
 *  2. Trong nhóm cột cùng tên gốc ("Bra Size (US/MX)", "Bra Size (EU)"...):
 *     - bỏ cột trùng giá trị 100% với cột khác (vd "Bra Size (EU/DE/INT)" vs "(DE/EU)")
 *     - nếu cả nhóm là biến thể theo VÙNG → chỉ giữ cột US (bán thị trường US), rename
 *       "Bra Size (US/MX/UK/CA/CO/PE)" → "Bra Size (US)" cho gọn header.
 */
export const normalizeSizeChartSections = (sections: SizeChartSection[]): SizeChartSection[] => {
  return sections
    .map((s) => {
      // 1. Bỏ cột rỗng toàn phần
      const headers = s.headers.filter((h) => s.data.some((r) => !isEmptyVal(r[h])));

      const baseName = (h: string) => h.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const colSig = (h: string) => s.data.map((r) => String(r[h] ?? "").trim()).join("|");

      const groups = new Map<string, string[]>();
      for (const h of headers) {
        const b = baseName(h).toLowerCase();
        groups.set(b, [...(groups.get(b) || []), h]);
      }

      const drop = new Set<string>();
      const rename = new Map<string, string>();
      for (const cols of groups.values()) {
        if (cols.length < 2) continue;
        // 2a. Dedup cột trùng giá trị trong cùng nhóm
        const seen = new Set<string>();
        for (const h of cols) {
          const sig = colSig(h);
          if (seen.has(sig)) drop.add(h);
          else seen.add(sig);
        }
        const kept = cols.filter((h) => !drop.has(h));
        if (kept.length < 2) continue;
        // 2b. Cả nhóm đều có "(REGION)" → giữ mỗi cột US
        if (kept.every((h) => /\([^)]*\)\s*$/.test(h))) {
          const us = kept.find((h) => /\([^)]*\b(?:US|USA)\b[^)]*\)\s*$/i.test(h));
          if (us) {
            for (const h of kept) if (h !== us) drop.add(h);
            const paren = us.match(/\(([^)]*)\)\s*$/)?.[1] || "";
            if (paren.includes("/")) rename.set(us, `${baseName(us)} (US)`);
          }
        }
      }

      const finalHeaders = headers.filter((h) => !drop.has(h)).map((h) => rename.get(h) || h);
      const data = s.data.map((r) => {
        const nr: Record<string, string> = {};
        for (const h of headers) {
          if (drop.has(h)) continue;
          nr[rename.get(h) || h] = r[h];
        }
        return nr;
      });
      if (finalHeaders.length < s.headers.length) {
        console.log(
          `📐 Size chart normalize: ${s.headers.length} → ${finalHeaders.length} cột (bỏ cột rỗng/trùng/khác vùng US)`
        );
      }
      return { ...s, headers: finalHeaders, data };
    })
    .filter((s) => s.headers.length > 0 && s.data.length > 0);
};

/**
 * Detect cột "multi-value" ("30C,32A,32B"): nếu section chỉ còn cột định danh (US/Size)
 * + đúng 1 cột multi-value → render dạng LIST CHIP (badge size + viên giá trị) thay vì
 * bảng — bảng với cell dài kiểu này rất dễ tràn/đè chữ.
 */
export const chipColumnOf = (s: SizeChartSection): string | null => {
  if (s.headers.length > 4) return null;
  const multi = s.headers.filter(
    (h) =>
      s.data.filter((r) => String(r[h] ?? "").includes(",")).length >=
      Math.ceil(s.data.length / 2)
  );
  return multi.length === 1 ? multi[0] : null;
};

/**
 * Render 1 ảnh size chart 900×900 chứa NHIỀU section (vd bikini 2 mảnh:
 * "Pants" + "Bikini Tops"). Mỗi section có tiêu đề riêng + bảng riêng,
 * gộp chung 1 card để upload 1 ảnh duy nhất lên TikTok Shop US.
 */
export const generateSizeChartHtml = (sections: SizeChartSection[], unit: string = "inch") => {
  // Tổng số dòng (mọi bảng) + dòng tiêu đề section → co padding cho khỏi tràn 900px.
  const totalRows = sections.reduce((sum, s) => sum + s.data.length + 1, 0);
  const titleRows = sections.length > 1 ? sections.length : 0;
  const sectionCount = sections.length;
  const weight = totalRows + titleRows * 1.2;
  // Co giãn font/padding theo tổng "tải" để 1..4 mảnh đều fit trong card 820px, không tràn.
  let rowPadding: number, cellFont: number;
  if (weight <= 8) { rowPadding = 20; cellFont = 28; }
  else if (weight <= 12) { rowPadding = 15; cellFont = 24; }
  else if (weight <= 16) { rowPadding = 10; cellFont = 19; }
  else if (weight <= 20) { rowPadding = 6; cellFont = 16; }
  else if (weight <= 26) { rowPadding = 5; cellFont = 14; }
  else { rowPadding = 4; cellFont = 12; }
  const sectionGap = sectionCount >= 3 ? 10 : 18;
  const titleFont = sectionCount >= 3 ? 16 : 18;
  const multi = sectionCount > 1;
  // 3+ mảnh: thu gọn header/footer để giành chỗ cho bảng (giữ font bảng to, dễ đọc).
  const dense = sectionCount >= 3;
  const headerPad = dense ? "16px 60px 12px" : "30px 60px 24px";
  const h1Font = dense ? 30 : 42;
  const footerPad = dense ? "0 60px 14px" : "0 60px 24px";

  const t = THEMES[Math.floor(Math.random() * THEMES.length)];
  console.log(`🎨 Size Chart theme: ${t.name} · sections=${sections.length} · rows=${totalRows}`);

  // Khoảng giá trị "26-38.6" → "26 – 38.6": dùng en-dash + khoảng trắng cho rõ, đỡ rối.
  // Multi-value "30C,32A" → "30C · 32A" (dấu chấm giữa + cho phép wrap, không đè cột bên).
  const fmtCell = (v: any) =>
    String(v ?? "")
      .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 – $2")
      .replace(/,\s*/g, " · ");
  // Cell dài (multi-value) → bảng phải cho wrap, nowrap sẽ tràn đè cột bên cạnh.
  const hasLongCells = sections.some((s) =>
    s.data.some((r) => s.headers.some((h) => String(r[h] ?? "").length > 12))
  );
  // Quá nhiều cột → ép font nhỏ thêm (weight cũ chỉ tính theo HÀNG).
  const maxCols = Math.max(...sections.map((s) => s.headers.length));
  if (maxCols >= 8) cellFont = Math.min(cellFont, 14);
  if (maxCols >= 11) cellFont = Math.min(cellFont, 12);

  // Layout CHIP cho section kiểu bra ("XS | US 2 | 30C · 32A · 32B"): badge size
  // + viên giá trị, thay vì bảng (cell dài làm bảng vỡ).
  const renderChipSection = (s: SizeChartSection, chipCol: string) => {
    const sizeCol = s.headers.find((h) => /^size$/i.test(h)) ?? s.headers[0];
    const metaCols = s.headers.filter((h) => h !== sizeCol && h !== chipCol);
    return `
    ${multi && s.name ? `<div class="section-title">${s.name}</div>` : ""}
    <div class="chip-head">${chipCol}</div>
    <div class="chip-rows">
      ${s.data
        .map((row) => {
          const chips = String(row[chipCol] ?? "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
            .map((c) => `<span class="chip">${c}</span>`)
            .join("");
          const meta = metaCols
            .map((h) => ({ h, v: String(row[h] ?? "").trim() }))
            .filter(({ v }) => v && v !== "/")
            .map(({ h, v }) => `${h} ${v}`)
            .join(" · ");
          return `<div class="chip-row">
            <div class="chip-size">${row[sizeCol] ?? ""}</div>
            ${meta ? `<div class="chip-meta">${meta}</div>` : ""}
            <div class="chip-list">${chips}</div>
          </div>`;
        })
        .join("")}
    </div>`;
  };

  const renderSection = (s: SizeChartSection) => {
    const chipCol = chipColumnOf(s);
    if (chipCol) return renderChipSection(s, chipCol);
    return `
    ${multi && s.name ? `<div class="section-title">${s.name}</div>` : ""}
    <table>
      <thead><tr>${s.headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${s.data
        .map(
          (row) =>
            `<tr>${s.headers.map((h) => `<td>${fmtCell(row[h])}</td>`).join("")}</tr>`
        )
        .join("")}</tbody>
    </table>`;
  };

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 900px; height: 900px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: ${t.bodyBg}; display: flex; align-items: center; justify-content: center; }
.card { width: 820px; height: 820px; background: ${t.cardBg}; border: 1.5px solid ${t.cardBorder}; border-radius: 2px; display: flex; flex-direction: column; position: relative; overflow: hidden; box-shadow: 0 4px 40px ${t.shadowColor}, inset 0 0 0 6px ${t.rowEvenBg}; }
.card::before, .card::after { content: ''; position: absolute; width: 28px; height: 28px; border-color: ${t.cornerColor}; border-style: solid; z-index: 2; }
.card::before { top: 12px; left: 12px; border-width: 2px 0 0 2px; }
.card::after  { bottom: 12px; right: 12px; border-width: 0 2px 2px 0; }
.header { background: ${t.headerBg}; padding: ${headerPad}; text-align: center; flex-shrink: 0; position: relative; }
.header .gold-line { position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent 0%, ${t.accentColor} 30%, ${t.accentMid} 50%, ${t.accentColor} 70%, transparent 100%); }
.header .label { color: ${t.labelColor}; font-size: 11px; letter-spacing: 7px; text-transform: uppercase; font-family: Arial, sans-serif; font-weight: 400; margin-bottom: ${dense ? 6 : 10}px; }
.header h1 { color: ${t.titleColor}; font-size: ${h1Font}px; font-weight: 800; letter-spacing: 8px; text-transform: uppercase; line-height: 1; }
.header .unit { color: ${t.unitColor}; font-size: 14px; letter-spacing: 3px; margin-top: ${dense ? 6 : 10}px; text-transform: uppercase; font-weight: 600; }
.table-wrap { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: ${sectionGap}px; padding: 0 44px 20px; }
.section-title { color: ${t.thColor}; font-size: ${titleFont}px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; padding: 2px 0 2px 12px; border-left: 4px solid ${t.cornerColor}; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead tr { border-bottom: 2px solid ${t.thBorder}; }
th { color: ${t.thColor}; font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; padding: ${rowPadding}px 6px; text-align: center; }
tbody tr { border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.25")}; }
tbody tr:nth-child(even) { background: ${t.rowEvenBg}; }
tbody tr:last-child { border-bottom: none; }
td { color: ${t.tdColor}; font-size: ${cellFont}px; font-weight: 600; padding: ${rowPadding}px 6px; text-align: center; letter-spacing: 0; font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; white-space: ${hasLongCells ? "normal" : "nowrap"}; word-break: break-word; }
td:first-child { color: ${t.tdFirst}; font-size: ${cellFont}px; letter-spacing: 0.5px; font-weight: 800; background: ${t.rowEvenBg.replace("0.06", "0.16")}; }
td:nth-child(2) { color: ${t.tdSecond}; font-weight: 800; font-size: ${cellFont + 2}px; letter-spacing: 1px; }
th:first-child { color: #fff; background: ${t.cornerColor}; }
/* ----- Layout CHIP (bra size...) ----- */
.chip-head { color: ${t.thColor}; font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; text-align: center; padding-bottom: 10px; border-bottom: 2px solid ${t.thBorder}; margin-bottom: 4px; }
.chip-rows { display: flex; flex-direction: column; }
.chip-row { display: flex; align-items: center; gap: 16px; padding: 12px 8px; border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.25")}; }
.chip-row:nth-child(even) { background: ${t.rowEvenBg}; }
.chip-row:last-child { border-bottom: none; }
.chip-size { flex: 0 0 74px; height: 52px; background: ${t.cornerColor}; color: #fff; font-size: 26px; font-weight: 800; letter-spacing: 1px; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.chip-meta { flex: 0 0 auto; min-width: 64px; color: ${t.tdFirst}; font-size: 16px; font-weight: 800; }
.chip-list { flex: 1; display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: #fff; border: 1.5px solid ${t.cardBorder}; color: ${t.tdColor}; font-size: 17px; font-weight: 700; padding: 6px 13px; border-radius: 18px; font-variant-numeric: tabular-nums; }
.footer { padding: ${footerPad}; text-align: center; flex-shrink: 0; }
.footer .divider { width: 50px; height: 1px; background: linear-gradient(90deg, transparent, ${t.footerDivider}, transparent); margin: 0 auto ${dense ? 8 : 12}px; }
.footer p { color: ${t.footerText}; font-size: 11px; font-style: italic; letter-spacing: 0.5px; font-family: Arial, sans-serif; }
</style></head>
<body>
  <div class="card">
    <div class="header">
      <div class="label">Measurements</div>
      <h1>Size Guide</h1>
      <div class="unit">Unit: ${unit}</div>
      <div class="gold-line"></div>
    </div>
    <div class="table-wrap">
      ${sections.map(renderSection).join("")}
    </div>
    <div class="footer">
      <div class="divider"></div>
      <p>* Please refer to the measurements above for the best fit.</p>
    </div>
  </div>
</body></html>`;
};

export interface MeasureGuide {
  items: { index?: string; name: string; desc: string }[];
  image?: string | null; // base64 data URI hoặc URL (đã che watermark)
}

/**
 * Ảnh GỘP "Size Guide" cho gallery sản phẩm (đặt sau ảnh main trên 4Seller):
 * bảng size + khối "How To Measure" (sơ đồ + hướng dẫn) trong 1 ảnh.
 * - Khung CỐ ĐỊNH 900×1200 (tỉ lệ 3:4 — đúng ratio TikTok cho phép, không bị crop).
 * - Tối đa 2 mảnh: 3 piece chỉ hiển thị 2 mảnh đầu (khung 3:4 không đủ chỗ).
 * - Header mỏng (bớt mảng nâu). Bố cục flex phân bổ ĐỀU theo chiều dọc để đầy khung,
 *   không bị nhồi (2 mảnh) cũng không trống huơ (1 mảnh).
 */
export interface SizeSuggestion {
  verdict: string;
  pct: number;
  advice: string;
  rows: { size: string; height: string; weight: string }[];
}

export const generateSizeGuideImageHtml = (
  sections: SizeChartSection[],
  measureGuide?: MeasureGuide | null,
  unit: string = "inch",
  sizeSuggestion?: SizeSuggestion | null
) => {
  const t = THEMES[Math.floor(Math.random() * THEMES.length)];
  const shown = sections.slice(0, 2);
  if (sections.length > shown.length) {
    console.log(`📐 Size Guide: ${sections.length} mảnh → hiển thị ${shown.length} mảnh đầu.`);
  }
  const multi = shown.length > 1;
  const fmtCell = (v: any) =>
    String(v ?? "")
      .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 – $2")
      .replace(/,\s*/g, " · ");
  const hasSg = !!sizeSuggestion?.rows?.length;
  const light = t.rowEvenBg.replace("0.06", "0.5");
  const border = t.rowEvenBg.replace("0.06", "1");
  // Cell dài (multi-value) → cho wrap, nowrap sẽ tràn đè cột bên cạnh.
  const hasLongCells = shown.some((s) =>
    s.data.some((r) => s.headers.some((h) => String(r[h] ?? "").length > 12))
  );

  // Layout CHIP cho section kiểu bra (xem chipColumnOf).
  const renderChipSection = (s: SizeChartSection, chipCol: string) => {
    const sizeCol = s.headers.find((h) => /^size$/i.test(h)) ?? s.headers[0];
    const metaCols = s.headers.filter((h) => h !== sizeCol && h !== chipCol);
    return `
    <div class="sec">
      ${multi && s.name ? `<div class="sec-title">${s.name}</div>` : ""}
      <div class="chip-head">${chipCol}</div>
      ${s.data
        .map((row) => {
          const chips = String(row[chipCol] ?? "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
            .map((c) => `<span class="chip">${c}</span>`)
            .join("");
          const meta = metaCols
            .map((h) => ({ h, v: String(row[h] ?? "").trim() }))
            .filter(({ v }) => v && v !== "/")
            .map(({ h, v }) => `${h} ${v}`)
            .join(" · ");
          return `<div class="chip-row">
            <div class="chip-size">${row[sizeCol] ?? ""}</div>
            ${meta ? `<div class="chip-meta">${meta}</div>` : ""}
            <div class="chip-list">${chips}</div>
          </div>`;
        })
        .join("")}
    </div>`;
  };

  const renderSection = (s: SizeChartSection) => {
    const chipCol = chipColumnOf(s);
    if (chipCol) return renderChipSection(s, chipCol);
    return `
    <div class="sec">
      ${multi && s.name ? `<div class="sec-title">${s.name}</div>` : ""}
      <table>
        <thead><tr>${s.headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${s.data
          .map((row) => `<tr>${s.headers.map((h) => `<td>${fmtCell(row[h])}</td>`).join("")}</tr>`)
          .join("")}</tbody>
      </table>
    </div>`;
  };

  const mgInner =
    measureGuide && measureGuide.items?.length
      ? `<div class="mg-row">
        ${measureGuide.image ? `<div class="mg-img"><img src="${measureGuide.image}" alt="measure guide"></div>` : ""}
        <div class="mg-list">
          ${measureGuide.items
            .map(
              (it, i) =>
                `<div class="mg-item"><span class="mg-num">${it.index || i + 1}</span><div><div class="mg-name">${it.name}</div><div class="mg-desc">${it.desc}</div></div></div>`
            )
            .join("")}
        </div>
      </div>`
      : "";

  const sg = hasSg
    ? `<div class="sg">
      <div class="sg-title">Size Recommendation</div>
      <div class="sg-verdict">${sizeSuggestion!.verdict} <b>(${sizeSuggestion!.pct}% true to size)</b></div>
      <table class="sg-table">
        <thead><tr><th>Size</th><th>Height</th><th>Weight</th></tr></thead>
        <tbody>${sizeSuggestion!.rows
          .slice(0, 6)
          .map((r) => `<tr><td class="sg-sz">${r.size}</td><td>${r.height}</td><td>${r.weight}</td></tr>`)
          .join("")}</tbody>
      </table>
      <div class="sg-advice">${sizeSuggestion!.advice}</div>
    </div>`
    : "";

  // Layout NGANG: Size Chart | How To Measure (2 cột cùng hàng) → Size Recommendation (hàng riêng, text to).
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 1200px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
.card { width: 1200px; background: #fff; border: 6px solid ${border}; }
.head { text-align: center; padding: 26px 40px 18px; border-bottom: 2px solid ${light}; }
.head .kicker { color: ${t.unitColor}; font-size: 14px; letter-spacing: 7px; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
.head h1 { color: ${t.thColor}; font-size: 46px; font-weight: 800; letter-spacing: 7px; text-transform: uppercase; line-height: 1; }
.head .unit { display: inline-block; margin-top: 11px; color: #fff; background: ${t.cornerColor}; font-size: 14px; letter-spacing: 2px; font-weight: 700; padding: 5px 18px; border-radius: 20px; text-transform: uppercase; }
/* ----- Hàng 2 cột: chart | measure ----- */
.main { display: flex; align-items: stretch; }
.col { padding: 26px 32px; }
.col-chart { flex: 1.15; border-right: 2px solid ${light}; }
.col-measure { flex: 1; }
.col-head { color: ${t.thColor}; font-size: 22px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; text-align: center; padding-bottom: 16px; }
.sec { margin-bottom: 14px; }
.sec-title { color: ${t.thColor}; font-size: 18px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; padding: 0 0 7px 10px; border-left: 4px solid ${t.cornerColor}; margin-bottom: 6px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead tr { background: ${t.rowEvenBg}; border-bottom: 2px solid ${t.thBorder}; }
th { color: ${t.thColor}; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 5px; text-align: center; }
th:first-child { color: #fff; background: ${t.cornerColor}; }
tbody tr { border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.3")}; }
tbody tr:nth-child(even) { background: ${t.rowEvenBg}; }
tbody tr:last-child { border-bottom: none; }
td { color: ${t.tdColor}; font-size: 16px; font-weight: 600; padding: 11px 5px; text-align: center; font-variant-numeric: tabular-nums; white-space: ${hasLongCells ? "normal" : "nowrap"}; word-break: break-word; }
td:first-child { color: ${t.tdFirst}; font-weight: 800; background: ${t.rowEvenBg.replace("0.06", "0.16")}; }
td:nth-child(2) { color: ${t.tdSecond}; font-weight: 800; font-size: 18px; }
/* ----- Layout CHIP (bra size...) ----- */
.chip-head { color: ${t.thColor}; font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; text-align: center; padding-bottom: 8px; border-bottom: 2px solid ${t.thBorder}; margin-bottom: 4px; }
.chip-row { display: flex; align-items: center; gap: 12px; padding: 10px 6px; border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.3")}; }
.chip-row:nth-child(even) { background: ${t.rowEvenBg}; }
.chip-row:last-child { border-bottom: none; }
.chip-size { flex: 0 0 60px; height: 44px; background: ${t.cornerColor}; color: #fff; font-size: 21px; font-weight: 800; letter-spacing: 1px; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.chip-meta { flex: 0 0 auto; min-width: 52px; color: ${t.tdFirst}; font-size: 14px; font-weight: 800; }
.chip-list { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: #fff; border: 1.5px solid ${t.cardBorder}; color: ${t.tdColor}; font-size: 14px; font-weight: 700; padding: 4px 10px; border-radius: 15px; font-variant-numeric: tabular-nums; }
.mg-row { display: flex; gap: 18px; align-items: center; }
.mg-img { flex: 0 0 175px; }
.mg-img img { width: 175px; height: auto; display: block; }
.mg-list { flex: 1; display: flex; flex-direction: column; gap: 13px; }
.mg-item { display: flex; gap: 12px; align-items: flex-start; }
.mg-num { flex: 0 0 28px; width: 28px; height: 28px; background: ${t.cornerColor}; color: #fff; font-size: 15px; font-weight: 800; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-top: 2px; }
.mg-name { color: ${t.thColor}; font-size: 17px; font-weight: 800; }
.mg-desc { color: ${t.tdColor}; font-size: 14px; line-height: 1.45; margin-top: 2px; }
/* ----- Size Recommendation (hàng riêng, TEXT TO) ----- */
.sg { border-top: 2px solid ${light}; padding: 26px 60px 18px; }
.sg-title { color: ${t.thColor}; font-size: 30px; font-weight: 800; letter-spacing: 4px; text-transform: uppercase; text-align: center; padding-bottom: 12px; }
.sg-verdict { text-align: center; font-size: 25px; font-weight: 700; color: ${t.tdColor}; margin-bottom: 18px; }
.sg-verdict b { color: #16a34a; }
.sg-table { border-collapse: collapse; width: 100%; max-width: 820px; margin: 0 auto; table-layout: fixed; }
.sg-table th { background: ${t.cornerColor}; color: #fff; font-size: 19px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; padding: 13px 12px; }
.sg-table tbody tr:nth-child(even) { background: ${t.rowEvenBg}; }
.sg-table td { font-size: 24px; font-weight: 700; color: ${t.tdColor}; text-align: center; padding: 15px 12px; border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.3")}; font-variant-numeric: tabular-nums; }
.sg-table .sg-sz { color: ${t.thColor}; font-weight: 800; font-size: 28px; }
.sg-advice { text-align: center; font-style: italic; color: ${t.footerText}; font-size: 18px; margin-top: 16px; }
.foot { text-align: center; padding: 14px 40px; background: ${t.rowEvenBg}; }
.foot p { color: ${t.footerText}; font-size: 13px; font-style: italic; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <div class="kicker">Measurements</div>
      <h1>Size Guide</h1>
      <div class="unit">Unit: ${unit}</div>
    </div>
    <div class="main">
      <div class="col col-chart"><div class="col-head">Size Chart</div>${shown.map(renderSection).join("")}</div>
      <div class="col col-measure"><div class="col-head">How To Measure</div>${mgInner}</div>
    </div>
    ${sg}
    <div class="foot"><p>* Please refer to the measurements above for the best fit.</p></div>
  </div>
</body></html>`;
};

/**
 * Build sections từ field size_chart (ưu tiên format mới `sections`, fallback `data` cũ).
 * Dùng chung cho cả ô Size Chart riêng lẫn ảnh gộp gallery.
 */
export const extractSizeChartSections = (sc: any): SizeChartSection[] => {
  let sections: SizeChartSection[] = [];
  if (sc?.sections?.length > 0) {
    sections = sc.sections
      .filter((s: any) => s?.data?.length > 0)
      .map((s: any) => ({
        name: s.name,
        headers: s.headers?.length ? s.headers : Object.keys(s.data[0]),
        data: s.data,
      }));
  } else if (sc?.data?.length > 0) {
    sections = [{ headers: Object.keys(sc.data[0]), data: sc.data }];
  }
  // Dọn cột rỗng/trùng/đa vùng trước khi render — bảng quá nhiều cột sẽ tràn/đè chữ.
  return normalizeSizeChartSections(sections);
};

/**
 * Render ảnh GỘP Size Guide (bảng + How To Measure) ra file PNG tạm, trả về path.
 * Caller chịu trách nhiệm xóa file sau khi upload xong.
 */
export const buildSizeGuideImageFile = async (
  sections: SizeChartSection[],
  measureGuide: MeasureGuide | null | undefined,
  unit: string,
  sizeSuggestion?: SizeSuggestion | null
): Promise<string> => {
  const id = crypto.randomBytes(8).toString("hex");
  const outPath = path.join(__dirname, `temp_size_guide_${id}.png`);
  await renderHtmlToImage({
    output: outPath,
    html: generateSizeGuideImageHtml(sections, measureGuide, unit, sizeSuggestion),
    viewport: { width: 1200, height: 1000 },
  });
  return outPath;
};

/**
 * Như buildSizeGuideImageFile nhưng trả về data URI base64 (xoá file tạm luôn).
 * Dùng để paste ảnh GỘP làm ảnh đầu trong mô tả (CKEditor upload qua clipboard image).
 */
export const buildSizeGuideImageDataUri = async (
  sections: SizeChartSection[],
  measureGuide: MeasureGuide | null | undefined,
  unit: string
): Promise<string> => {
  const file = await buildSizeGuideImageFile(sections, measureGuide, unit);
  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
};

export const handleSizeChartUpload = async (page: any, jsonData: any): Promise<void> => {
  if (!jsonData.size_chart && !jsonData.size_chart_img) return;

  console.log("📐 Đang chuẩn bị xử lý Size Chart...");
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempPath = path.join(__dirname, `temp_size_chart_${uniqueId}.png`);

  try {
    // Build sections (ô Size Chart riêng vẫn dùng ảnh bảng-only cũ).
    const sc = jsonData.size_chart;
    const sections: SizeChartSection[] = extractSizeChartSections(sc);

    if (sections.length > 0) {
      console.log(`🎨 Tạo ảnh từ JSON (ID: ${uniqueId}, sections: ${sections.length})`);
      await renderHtmlToImage({
        output: tempPath,
        html: generateSizeChartHtml(sections, sc.unit || "inch"),
        viewport: { width: 900, height: 900 },
      });
    } else if (jsonData.size_chart_img) {
      console.log("📸 Sử dụng ảnh base64 có sẵn...");
      const base64Data = jsonData.size_chart_img.split(",")[1];
      const buffer = Buffer.from(base64Data, "base64");
      await fsPromises.writeFile(tempPath, new Uint8Array(buffer));
    }

    const sizeChartInput = page.locator(
      'xpath=(//*[contains(text(), "Size Chart")]/following::div[contains(@class, "file_upload__index")]//input[@type="file"])[1]'
    );

    try {
      await sizeChartInput.waitFor({ state: "attached", timeout: 10000 });
      await sizeChartInput.setInputFiles(tempPath);
      console.log(`✅ Đã upload Size Chart thành công (ID: ${uniqueId})`);
    } catch (e) {
      console.error(`❌ Không tìm thấy ô upload cho Size Chart (ID: ${uniqueId})`, e);
    }

    await page.waitForTimeout(2000);

    if (await fsPromises.stat(tempPath).catch(() => null)) {
      await fsPromises.unlink(tempPath).catch(() => {});
    }
  } catch (err) {
    console.error("❌ Lỗi xử lý Size Chart:", err);
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        await fsPromises.unlink(tempPath);
        console.log(`🧹 Đã xóa file tạm: ${uniqueId}`);
      } catch {
        console.warn(`⚠️ File ${uniqueId} đang bận, sẽ xóa sau.`);
        setTimeout(() => fs.unlink(tempPath, () => {}), 5000);
      }
    }
  }
};
