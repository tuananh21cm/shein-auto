import fs from "fs";
import path from "path";
import crypto from "crypto";
import { promises as fsPromises } from "fs";

/**
 * Render HTML thành PNG bằng chính Chromium đang chạy listing — tránh phụ thuộc
 * node-html-to-image (kéo Puppeteer v23, bị ERR_UNSUPPORTED_ESM_URL_SCHEME
 * trên Windows khi resolve browser binary).
 */
const renderHtmlToPng = async (page: any, html: string, outputPath: string): Promise<void> => {
  const browser = page.context().browser();
  if (!browser) {
    throw new Error("Không lấy được Browser từ page để render Size Chart");
  }
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  try {
    const renderPage = await ctx.newPage();
    await renderPage.setContent(html, { waitUntil: "load" });
    await renderPage.screenshot({ path: outputPath, type: "png", fullPage: false });
  } finally {
    await ctx.close().catch(() => {});
  }
};

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

const generateSizeChartHtml = (data: any[], headers: string[], unit: string = "inch") => {
  const rowCount = data.length;
  const rowPadding = rowCount <= 6 ? 20 : rowCount <= 10 ? 14 : 9;

  const t = THEMES[Math.floor(Math.random() * THEMES.length)];
  console.log(`🎨 Size Chart theme: ${t.name}`);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 900px; height: 900px; font-family: 'Georgia', 'Times New Roman', serif; background: ${t.bodyBg}; display: flex; align-items: center; justify-content: center; }
.card { width: 820px; height: 820px; background: ${t.cardBg}; border: 1.5px solid ${t.cardBorder}; border-radius: 2px; display: flex; flex-direction: column; position: relative; overflow: hidden; box-shadow: 0 4px 40px ${t.shadowColor}, inset 0 0 0 6px ${t.rowEvenBg}; }
.card::before, .card::after { content: ''; position: absolute; width: 28px; height: 28px; border-color: ${t.cornerColor}; border-style: solid; z-index: 2; }
.card::before { top: 12px; left: 12px; border-width: 2px 0 0 2px; }
.card::after  { bottom: 12px; right: 12px; border-width: 0 2px 2px 0; }
.header { background: ${t.headerBg}; padding: 34px 60px 28px; text-align: center; flex-shrink: 0; position: relative; }
.header .gold-line { position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent 0%, ${t.accentColor} 30%, ${t.accentMid} 50%, ${t.accentColor} 70%, transparent 100%); }
.header .label { color: ${t.labelColor}; font-size: 11px; letter-spacing: 7px; text-transform: uppercase; font-family: Arial, sans-serif; font-weight: 400; margin-bottom: 10px; }
.header h1 { color: ${t.titleColor}; font-size: 40px; font-weight: 700; letter-spacing: 10px; text-transform: uppercase; line-height: 1; }
.header .unit { color: ${t.unitColor}; font-size: 12px; letter-spacing: 3px; margin-top: 12px; text-transform: uppercase; font-family: Arial, sans-serif; }
.table-wrap { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 0 52px 24px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead tr { border-bottom: 2px solid ${t.thBorder}; }
th { color: ${t.thColor}; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 3px; padding: ${rowPadding}px 8px; text-align: center; font-family: Arial, sans-serif; }
tbody tr { border-bottom: 1px solid ${t.rowEvenBg.replace("0.06", "0.25")}; }
tbody tr:nth-child(even) { background: ${t.rowEvenBg}; }
tbody tr:last-child { border-bottom: none; }
td { color: ${t.tdColor}; font-size: 20px; font-weight: 500; padding: ${rowPadding}px 8px; text-align: center; letter-spacing: 0.5px; }
td:first-child { color: ${t.tdFirst}; font-size: 15px; font-family: Arial, sans-serif; letter-spacing: 1.5px; font-weight: 600; }
td:nth-child(2) { color: ${t.tdSecond}; font-weight: 800; font-size: 21px; letter-spacing: 2.5px; }
.footer { padding: 0 60px 28px; text-align: center; flex-shrink: 0; }
.footer .divider { width: 50px; height: 1px; background: linear-gradient(90deg, transparent, ${t.footerDivider}, transparent); margin: 0 auto 14px; }
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
      <table>
        <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${data
          .map(
            (row) =>
              `<tr>${headers.map((h) => `<td>${row[h] ?? ""}</td>`).join("")}</tr>`
          )
          .join("")}</tbody>
      </table>
    </div>
    <div class="footer">
      <div class="divider"></div>
      <p>* Please refer to the measurements above for the best fit.</p>
    </div>
  </div>
</body></html>`;
};

export const handleSizeChartUpload = async (page: any, jsonData: any): Promise<void> => {
  if (!jsonData.size_chart && !jsonData.size_chart_img) return;

  console.log("📐 Đang chuẩn bị xử lý Size Chart...");
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempPath = path.join(__dirname, `temp_size_chart_${uniqueId}.png`);

  try {
    // 2 format data: cũ {data:[...]} / mới (crawler v27+) {sections:[{name,headers,data}]} — lấy section đầu (đồ chính)
    const sc = jsonData.size_chart;
    let chartRows: any[] | null = null;
    let chartHeaders: string[] | null = null;
    if (sc?.data?.length > 0) {
      chartRows = sc.data;
      chartHeaders = Object.keys(sc.data[0]);
    } else if (sc?.sections?.length > 0) {
      const s = sc.sections.find((x: any) => x?.data?.length) ?? null;
      if (s) { chartRows = s.data; chartHeaders = s.headers?.length ? s.headers : Object.keys(s.data[0]); }
    }

    if (chartRows && chartHeaders) {
      console.log(`🎨 Tạo ảnh từ JSON (ID: ${uniqueId})`);
      const html = generateSizeChartHtml(chartRows, chartHeaders);
      await renderHtmlToPng(page, html, tempPath);
    } else if (jsonData.size_chart_img) {
      console.log("📸 Sử dụng ảnh base64 có sẵn...");
      const base64Data = jsonData.size_chart_img.split(",")[1];
      const buffer = Buffer.from(base64Data, "base64");
      await fsPromises.writeFile(tempPath, new Uint8Array(buffer));
    }

    // Không render/ghi được file → đừng setInputFiles (trước đây ném ENOENT gây log lỗi ảo)
    if (!fs.existsSync(tempPath)) {
      console.log("ℹ️ Không có data size chart dạng render được — bỏ qua upload Size Chart.");
      return;
    }

    const sizeChartInput = page.locator(
      'xpath=(//*[contains(text(), "Size Chart")]/following::div[contains(@class, "file_upload__index")]//input[@type="file"])[1]'
    );

    try {
      await sizeChartInput.waitFor({ state: "attached", timeout: 10000 });

      // Upload + retry 1 lần nếu 4Seller báo "Upload Failure!" (server glitch thoáng qua).
      // Size chart là ảnh PHỤ — thất bại thì bỏ qua, nhưng phải CHỜ toast lỗi tắt hẳn
      // để assertNoErrors ở ngoài không tưởng nhầm là lỗi nghiêm trọng rồi giết listing.
      const failToast = page.locator(".el-message--error", { hasText: /upload fail/i });
      for (let attempt = 1; attempt <= 2; attempt++) {
        await sizeChartInput.setInputFiles(tempPath);
        await page.waitForTimeout(3500); // chờ upload + toast (nếu lỗi) xuất hiện
        if (!(await failToast.first().isVisible().catch(() => false))) {
          console.log(`✅ Đã upload Size Chart thành công (ID: ${uniqueId}, lần ${attempt})`);
          break;
        }
        console.warn(`⚠️ 4Seller báo Upload Failure cho Size Chart (lần ${attempt}/2)${attempt < 2 ? " → thử lại…" : " → bỏ qua (ảnh phụ)."}`);
        // Chờ toast tự tắt trước khi thử lại / đi tiếp (el-message tự dismiss ~3s)
        await failToast.first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
      }
    } catch (e) {
      console.error(`❌ Không tìm thấy ô upload cho Size Chart (ID: ${uniqueId})`, e);
    }

    await page.waitForTimeout(1000);

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
