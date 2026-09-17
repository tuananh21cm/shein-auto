/**
 * Đăng listing 4Seller qua HTTP API (thay Playwright) — spec: docs/4seller-listing-api.md.
 * Cùng input/opts với listing4sellerShein; lỗi → caller fallback Playwright.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright-core";
import { genTitleFromShein } from "../services/gemini/genTitleFromShein";
import { cleanTitle } from "../utils/cleanTitle";
import { computeFinalPrice, pricing, specificsMap, workerConfig } from "../config/appConfig";
import { resolveBrandForUser } from "../state/userDirs";
import { normShopName, resolveAccountForShop } from "../state/fourSellerAccounts";
import { fourSellerGet, fourSellerPost, getCategoryList, getShopList, CategoryNode } from "../services/fourseller/client";
import { generateRandomString, getProfileNameFromFolder } from "./steps/randomUtils";
import { resolveSpecifics } from "./steps/fillSpecifics";
import { findCategory } from "./steps/findCategory";
import { preprocessData } from "./steps/preprocessData";
import { buildColorShowcaseImageFile } from "./steps/colorShowcase";
import { generateSizeChartHtml } from "./steps/handleSizeChart";
import { buildDescriptionHtml } from "./buildDescriptionHtml";

type Attr = { attrId: string | number; attrName: string; attrType: number; isCustomized?: number; valueList?: string };

const schemaCache = new Map<string, Attr[]>();
const warehouseCache = new Map<string, string>();
const catCache = new Map<string, CategoryNode[]>();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Walk "A / B / C" xuống cây category 4Seller → node leaf + path id. */
const resolveCategory = async (principal: string, shopId: number, pathStr: string) => {
  const segs = pathStr.split(" / ").map((s) => s.trim()).filter(Boolean);
  let parentId = "0";
  const ids: string[] = [];
  const names: string[] = [];
  let node: CategoryNode | null = null;
  for (const seg of segs) {
    const key = `${shopId}:${parentId}`;
    let list = catCache.get(key);
    if (!list) { list = await getCategoryList(principal, parentId, shopId); catCache.set(key, list); }
    node = list.find((c) => norm(c.categoryName) === norm(seg)) ?? null;
    if (!node) throw new Error(`Category không khớp cây 4Seller: "${seg}" trong "${pathStr}"`);
    ids.push(String(node.categoryId)); names.push(node.categoryName); parentId = String(node.categoryId);
  }
  if (!node || !node.leafCategory) throw new Error(`Category không phải leaf: ${pathStr}`);
  return { categoryId: String(node.categoryId), categoryName: node.categoryName, categoryPath: names.join("/"), categoryIdPath: ids.join("/") };
};

const parseVals = (a: Attr): { id: string; name: string }[] => {
  try { return (JSON.parse(a.valueList || "[]") as any[]).map((v) => ({ id: String(v.id), name: v.name })); } catch { return []; }
};

const getSchema = async (principal: string, shopId: number, categoryId: string): Promise<Attr[]> => {
  const key = `${shopId}:${categoryId}`;
  let attrs = schemaCache.get(key);
  if (!attrs) {
    attrs = await fourSellerGet<Attr[]>(principal, `/api/meta/tiktok/get-category-attribute-list-by-id?categoryId=${categoryId}&site=US&shopId=${shopId}`);
    schemaCache.set(key, attrs);
  }
  return attrs;
};

/** Sales attribute (attrType=2): Color/Size → map tên → valueId + cờ cho phép giá trị custom. */
const salesValueMap = (attrs: Attr[], categoryId: string) => {
  const pick = (name: string) => {
    const a = attrs.find((x) => x.attrType === 2 && norm(x.attrName) === norm(name));
    if (!a) throw new Error(`Category ${categoryId} không có sales attr "${name}"`);
    const m = new Map(parseVals(a).map((v) => [norm(v.name), v]));
    return { attrId: String(a.attrId), attrName: a.attrName, m, custom: a.isCustomized === 1 };
  };
  return { color: pick("Color"), size: pick("Size") };
};

/**
 * Giá trị chuẩn → key = valueId; giá trị lạ (SHEIN đặt tên riêng) → 4Seller gửi key = CHÍNH TÊN đó,
 * vd {"Dusty Pink":"Dusty Pink"} (bắt được từ capture publish thật 16/09). Tên chuẩn lấy theo
 * valueList để khớp hoa/thường ("Light Yellow" → "Light yellow").
 */
const resolveVals = (names: string[], s: ReturnType<typeof salesValueMap>["color"], label: string) =>
  names.map((n) => {
    const v = s.m.get(norm(n));
    if (v) return { key: v.id, name: v.name };
    if (!s.custom) throw new Error(`${label} "${n}" không có trong valueList TikTok và attr không cho custom`);
    return { key: n, name: n };
  });

// 3 câu compliance luôn trả "No" (Playwright điền ở fillShippingAndCertification).
const COMPLIANCE = ["caprop65reprochems", "caprop65carcinogens", "dangerousgoodsorhazardousmaterials"];

/**
 * Thuộc tính TỰ ĐIỀN cho mọi listing — chỉ điền khi category có field đó và SHEIN không
 * cung cấp dữ liệu thật cho field (dữ liệu thật ưu tiên hơn). Thêm cặp mới = thêm 1 dòng.
 */
const DEFAULT_SPECIFICS: Record<string, string> = {
  "Country of origin": "USA",   // id 100149 — có ở cả đồ đầm lẫn áo
  "Clothing length": "Medium",  // id 100394 — chỉ có ở nhóm áo (đầm dùng "Dress length")
};

/** productAttributes (attrType=3): compliance "No" + Specifics map từ SHEIN + default tự điền. */
const buildProductAttributes = (schema: Attr[], sheinAttrs: Record<string, string>): string => {
  const prod = schema.filter((a) => a.attrType === 3);
  const out: any[] = [];
  for (const a of prod) {
    if (!COMPLIANCE.includes(norm(a.attrName))) continue;
    const no = parseVals(a).find((v) => /^no$/i.test(v.name));
    if (no) out.push({ attributeId: String(a.attrId), attributeName: a.attrName, values: [{ valueId: no.id, valueName: no.name, isShow: true }] });
  }
  const byNorm = new Map(prod.filter((a) => !COMPLIANCE.includes(norm(a.attrName))).map((a) => [norm(a.attrName), a]));
  // Playwright dùng getByPlaceholder(`Select ${label}`).first() = khớp TIỀN TỐ, nên nhãn "Fit"
  // vẫn trúng field "Fit type". Khớp tuyệt đối trước, không có thì mới lấy tiền tố.
  const findAttr = (label: string) =>
    byNorm.get(norm(label)) ?? [...byNorm.entries()].find(([n]) => n.startsWith(norm(label)))?.[1];
  // Field đã có giá trị thì bỏ qua → default không đè dữ liệu thật của SHEIN.
  const push = (a: Attr, v: { id: string; name: string }) => {
    if (out.some((x) => x.attributeId === String(a.attrId))) return;
    out.push({ attributeId: String(a.attrId), attributeName: a.attrName, values: [{ valueId: v.id, valueName: v.name }] });
  };

  if (workerConfig().fillSpecifics) {
    const cfg = specificsMap();
    const fieldOptions: Record<string, string[]> = {};
    const byLabel = new Map<string, Attr>();
    for (const t of new Set(Object.values(cfg.keyMap).flat() as string[])) {
      const a = findAttr(t);
      if (a) { fieldOptions[t] = parseVals(a).map((v) => v.name); byLabel.set(t, a); }
    }
    for (const [field, chosen] of Object.entries(resolveSpecifics(sheinAttrs, fieldOptions, cfg))) {
      const a = byLabel.get(field);
      const v = a && parseVals(a).find((x) => x.name === chosen);
      if (a && v) push(a, v);
    }
  }

  for (const [label, want] of Object.entries(DEFAULT_SPECIFICS)) {
    const a = findAttr(label);
    const v = a && parseVals(a).find((x) => norm(x.name) === norm(want));
    if (a && v) push(a, v);
    else if (a) console.warn(`⚠️ [API] "${a.attrName}" không có giá trị "${want}" trong valueList → bỏ qua`);
  }
  return JSON.stringify(out);
};

const defaultWarehouse = async (principal: string, shopId: number) => {
  const k = String(shopId);
  if (!warehouseCache.has(k)) {
    const list = await fourSellerGet<{ warehouseId: string; isDefault: boolean }[]>(principal, `/api/meta/tiktok/get-warehouse-list-by-shop-id?shopId=${shopId}&fbt=0&allocationMode=`);
    const w = list.find((x) => x.isDefault) ?? list[0];
    if (!w) throw new Error(`Shop ${shopId} không có warehouse`);
    warehouseCache.set(k, String(w.warehouseId));
  }
  return warehouseCache.get(k)!;
};

// Giới hạn TỔNG số upload COS chạy cùng lúc trong cả tiến trình. Trước đây mỗi nhóm ảnh tự
// chạy 4 luồng và tất cả các nhóm lại nằm trong 1 Promise.all → sp 35 màu bung ~140 kết nối
// đồng thời → undici ném "terminated" giữa chừng, hỏng cả listing.
// Trần này phải CO GIÃN theo concurrency: nó là trần TỔNG, nên để cố định 6 thì tăng
// concurrency chỉ chia nhỏ luồng cho mỗi listing (6 listing → 1 luồng/listing), tổng số ảnh
// đẩy lên mỗi giây không đổi — tăng concurrency thành vô nghĩa. Cận trên 24 để không quay
// lại lỗi undici "terminated" (~140 kết nối đồng thời làm hỏng cả listing).
const upLimit = () => Math.max(6, Math.min(24, (workerConfig().concurrency || 1) * 2));
let upActive = 0;
const upQueue: (() => void)[] = [];
const upAcquire = async () => {
  if (upActive >= upLimit()) await new Promise<void>((r) => upQueue.push(r));
  upActive++;
};
const upRelease = () => {
  upActive--;
  upQueue.shift()?.();
};

/** Ảnh → COS: tải (hoặc đọc file) → md5 → get-sign → PUT → URL. */
const uploadImageOnce = async (principal: string, src: string, fileName: string): Promise<string> => {
  let buf: Buffer;
  let ct = "image/jpeg";
  if (/^https?:/.test(src)) {
    const r = await fetch(src, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Tải ảnh ${r.status}: ${src}`);
    buf = Buffer.from(await r.arrayBuffer());
    ct = r.headers.get("content-type")?.split(";")[0] || ct;
  } else {
    buf = fs.readFileSync(src);
    ct = /\.png$/i.test(src) ? "image/png" : ct;
  }
  // Ảnh SHEIN là .webp. PUT nguyên xi thì trên COS thành image/webp trong khi key đuôi .jpg —
  // đo thật: 248/249 ảnh API ra image/webp, còn Playwright ra image/jpeg 100% (vì đi qua form
  // upload của 4Seller, nó tự convert). TikTok chỉ nhận JPEG/PNG → convert trước khi upload.
  if (ct !== "image/jpeg" && ct !== "image/png") {
    const sharp = (await import("sharp")).default;
    buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    ct = "image/jpeg";
  }
  const md5 = crypto.createHash("md5").update(buf).digest("hex");
  const sign = await fourSellerPost<{ key: string; sign: string; sessionToken: string; domain: string }>(principal, "/api/cos/get-sign", { md5, fileName, referenceType: "tiktok" });
  const url = `https://${sign.domain}${sign.key}`;
  const put = await fetch(url, { method: "PUT", headers: { Authorization: sign.sign, "x-cos-security-token": sign.sessionToken, "Content-Type": ct }, body: new Uint8Array(buf) });
  if (!put.ok) throw new Error(`PUT COS ${put.status}: ${fileName}`);
  return url;
};

/** Upload có hàng đợi + retry: 1 ảnh lỗi mạng là hỏng cả listing nên đáng thử lại. */
const uploadImage = async (principal: string, src: string, fileName: string): Promise<string> => {
  await upAcquire();
  try {
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await uploadImageOnce(principal, src, fileName); } catch (e: any) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw new Error(`Upload ảnh thất bại sau 3 lần (${String(lastErr?.message ?? lastErr).slice(0, 80)}): ${fileName}`);
  } finally { upRelease(); }
};

const uploadMany = async (principal: string, srcs: string[], prefix: string, par = 4): Promise<string[]> => {
  const out: string[] = new Array(srcs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(par, srcs.length) }, async () => {
    while (i < srcs.length) { const k = i++; out[k] = await uploadImage(principal, srcs[k], `${prefix}_${k}.jpg`); }
  }));
  return out;
};

/** Size chart PNG: render HTML 900x900 bằng chromium headless (cùng generator với Playwright). */
const renderSizeChartPng = async (sizeChart: any): Promise<string | null> => {
  let rows: any[] | null = null, headers: string[] | null = null;
  if (sizeChart?.data?.length) { rows = sizeChart.data; headers = Object.keys(sizeChart.data[0]); }
  else if (sizeChart?.sections?.length) {
    const s = sizeChart.sections.find((x: any) => x?.data?.length);
    if (s) { rows = s.data; headers = s.headers?.length ? s.headers : Object.keys(s.data[0]); }
  }
  if (!rows || !headers) return null;
  // LUÔN inch — xem ghi chú trong handleSizeChart.ts: `unit` trong data không đáng tin.
  const html = generateSizeChartHtml(rows, headers, "inch");
  const out = path.join(process.cwd(), "data", "tmp", `sizechart_${crypto.randomBytes(6).toString("hex")}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 900, height: 900 } });
  } finally { await browser.close(); }
  return out;
};

export const listing4sellerApi = async (
  jsonFile: string,
  opts?: {
    dryRun?: boolean;
    cookieUser?: string;
    pricing?: { shipFee: number; multiplier: number; extraAdd: number };
    /** Chỉ dùng kèm dryRun khi TEST: vẫn render/ghép ảnh nhưng KHÔNG upload lên COS (nhanh, không rác). */
    skipImages?: boolean;
  }
): Promise<{ listingId?: string; payload: any }> => {
  if (!path.isAbsolute(jsonFile)) throw new Error(`listing4sellerApi chỉ nhận absolute path: "${jsonFile}"`);
  const data = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
  // File cào hỏng phải báo lỗi RÕ ngay từ đầu (trước đây gãy sâu bên trong với
  // "Cannot read properties of undefined (reading 'trim')"). queueManager cần phân biệt
  // "dữ liệu hỏng → bỏ file" với "lỗi API → fallback Playwright".
  for (const k of ["product_name", "category"] as const) {
    if (!String(data[k] ?? "").trim()) throw new Error(`JSON hỏng: thiếu "${k}" — file cào lỗi, không đăng được`);
  }
  const targetProfile = getProfileNameFromFolder(jsonFile);
  const shopPrefs: Record<string, boolean> = (() => {
    try { const all = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "shop-listing.json"), "utf-8")); return all[targetProfile] ?? all["__default"] ?? {}; } catch { return {}; }
  })();
  const prefOn = (k: string) => shopPrefs[k] !== false;

  // Account + shopId theo folder shop (đa tài khoản 4Seller).
  const acct = await resolveAccountForShop(targetProfile);
  const principal = acct ? `acct:${acct.uid}` : opts?.cookieUser;
  if (!principal) throw new Error(`Không tìm được tài khoản 4Seller cho shop "${targetProfile}"`);
  const shops = await getShopList(principal);
  const shop = shops.records.find((s) => normShopName(s.shopName) === normShopName(targetProfile) || normShopName(s.platformShopName) === normShopName(targetProfile));
  if (!shop) throw new Error(`Shop "${targetProfile}" không có trong 4Seller (${principal})`);
  const shopId = shop.id;
  console.log(`🌐 [API] ${targetProfile} → shopId=${shopId} (${principal})`);

  // AI song song: title + category path + description.
  const t0 = Date.now();
  const [aiTitle, catPath] = await Promise.all([genTitleFromShein(data.product_name), findCategory(data.category)]);
  const brand = await resolveBrandForUser(opts?.cookieUser, targetProfile);
  const productName = cleanTitle(aiTitle, brand);
  const [cat, warehouseId] = await Promise.all([resolveCategory(principal, shopId, catPath), defaultWarehouse(principal, shopId)]);
  const schema = await getSchema(principal, shopId, cat.categoryId);
  const sales = salesValueMap(schema, cat.categoryId);
  console.log(`📂 [API] ${cat.categoryPath} (${cat.categoryIdPath}) · warehouse ${warehouseId}`);

  const { mergedProductImages } = preprocessData(data);
  const colors: string[] = data.listing_variations?.colors || [];
  const sizes: string[] = data.listing_variations?.sizes || [];
  if (!colors.length || !sizes.length) throw new Error("Thiếu colors/sizes trong listing_variations");
  const colorVals = resolveVals(colors, sales.color, "Màu");
  const sizeVals = resolveVals(sizes, sales.size, "Size");
  const nCustom = colorVals.filter((v, i) => v.key === colors[i] && !sales.color.m.has(norm(colors[i]))).length;
  if (nCustom) console.log(`🎨 [API] ${nCustom} màu custom (không có trong valueList TikTok) → gửi dạng {tên:tên}`);

  // Giá/SKU/qty — y hệt fillTableData + setOosVariantQuantity.
  const roundTo99 = (p: number) => Math.floor(p) + 0.99;
  const calcPrice = (n: number) => roundTo99(opts?.pricing ? (n + opts.pricing.shipFee) * opts.pricing.multiplier + opts.pricing.extraAdd : computeFinalPrice(n));
  const priceMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(Object.assign({}, ...(data.variant_price || [])) as Record<string, string>)) priceMap[k.toLowerCase().trim()] = v;
  const toNum = (v: any) => parseFloat(String(v).replace(",", ".").replace(/[^0-9.]/g, ""));
  const fallbackRaw = Object.values(priceMap).map(toNum).find((n) => !isNaN(n));
  const skuMap: Record<string, string> = {};
  for (const it of data.variant_ids || []) for (const [k, v] of Object.entries(it)) skuMap[k.toLowerCase().trim()] = String(v);
  const avail: Record<string, Set<string>> | null = data.available_matrix && Object.keys(data.available_matrix).length
    ? Object.fromEntries(Object.entries(data.available_matrix as Record<string, string[]>).map(([c, ss]) => [c.toLowerCase().trim(), new Set(ss.map((s) => s.toLowerCase().trim()))]))
    : null;
  const variation: any[] = [];
  let keyId = 1;
  for (const c of colors) {
    const ck = c.toLowerCase().trim();
    let n = toNum(priceMap[ck]);
    if (isNaN(n)) { if (fallbackRaw === undefined) throw new Error(`Màu "${c}" không có giá`); n = fallbackRaw; }
    const price = calcPrice(n).toFixed(2);
    const sku = skuMap[ck] ?? generateRandomString();
    for (const s of sizes) {
      const stock = avail && !avail[ck]?.has(s.toLowerCase().trim()) ? "0" : "20";
      variation.push({
        keyId: keyId++, type: "auto", erpSku: "", sellerSku: sku, attrs: [c, s], identifierCodeType: 3, identifierCode: "",
        availableStock: stock, originalPrice: price, currency: "USD", newAdd: true, globalPrice: "", globalStock: 0,
        unitType: "meter", unitTypeNum: 1, skuUnitCount: "", globalStockInfoList: [], packageWeight: "", weightUnit: pricing().weightUnit ?? "POUND",
        packageLength: "", packageWidth: "", packageHeight: "", dimensionUnit: pricing().dimensionUnit ?? "INCH",
        stockInfoList: [{ warehouse_id: warehouseId, available_stock: stock }], priceAndInventoryList: [], option1: c, option2: s,
      });
    }
  }

  // Ảnh: main (+showcase) / variant theo màu / size chart → COS.
  const mainSrc: string[] = prefOn("variantToMain") ? mergedProductImages : (data.product_images || []).slice(0, workerConfig().imageUploadMaxImages);
  const maxImgs = workerConfig().imageUploadMaxImages || 9;
  const showcaseCfg = workerConfig().colorShowcase;
  let showcaseFile: string | null = null;
  if (showcaseCfg?.enabled && prefOn("colorShowcase")) {
    try { showcaseFile = await buildColorShowcaseImageFile(data.product_images, data.variant_images, showcaseCfg.style ?? "B", { bgSeed: targetProfile }); }
    catch (e: any) { console.warn(`⚠️ color showcase lỗi, bỏ qua: ${e?.message ?? e}`); }
  }
  const sizeChartFile = await renderSizeChartPng(data.size_chart).catch((e) => { console.warn("⚠️ size chart render lỗi:", e?.message); return null; });
  const tUp = Date.now();
  // Test mode: vẫn render size chart / showcase / mô tả, chỉ bỏ bước PUT lên COS.
  const skipImg = !!(opts?.skipImages && opts?.dryRun);
  const up1 = (f: string | null, name: string) =>
    !f ? Promise.resolve("") : skipImg ? Promise.resolve(`skip://${name}`) : uploadImage(principal, f, name);
  const upN = (srcs: string[], prefix: string) =>
    skipImg ? Promise.resolve(srcs.map((_s, i) => `skip://${prefix}_${i}`)) : uploadMany(principal, srcs, prefix);
  const [mainUrls, showcaseUrl, sizeChartUrl, descRes, ...variantUrls] = await Promise.all([
    // Cap tổng ảnh Main tại maxImgs: showcase chiếm 1 slot thì bỏ ảnh cuối (4Seller/TikTok
    // báo "exceed the limit image count" nếu quá 9) — giống uploadProductImages.
    upN(mainSrc.slice(0, maxImgs - (showcaseFile ? 1 : 0)), "main"),
    up1(showcaseFile, "showcase.jpg"),
    up1(sizeChartFile, "sizechart.png"),
    buildDescriptionHtml(data, prefOn),
    ...colors.map((c) => {
      const it = (data.variant_images || []).find((x: any) => x[c] !== undefined);
      const urls: string[] = it ? (Array.isArray(it[c]) ? it[c] : [it[c]]) : [];
      return upN(urls.slice(0, 9), `v_${norm(c)}`);
    }),
  ]);
  for (const f of [showcaseFile, sizeChartFile]) if (f) fs.promises.unlink(f).catch(() => {});
  const nImg = mainUrls.length + (showcaseUrl ? 1 : 0) + (sizeChartUrl ? 1 : 0) + variantUrls.reduce((a, b) => a + b.length, 0);
  console.log(`🖼️ [API] upload ${nImg} ảnh trong ${Math.round((Date.now() - tUp) / 1000)}s`);

  const p = pricing();
  const { descHtml, rich } = descRes;
  const payload = {
    id: "", requireMessage: "", isGlobal: 0, shopId, currentShopId: shopId, region: "LOCAL TO LOCAL", shopCurrency: "", isMultiWarehouse: 0, mainShop: 0,
    productName, ...cat, hasVariation: 1, identifierCodeType: 3, identifierCode: "", erpSku: "", erpSkuId: "", sellerSku: "",
    description: descHtml,
    packageWeight: p.defaultWeight, packageLength: p.defaultDimensions.length, packageWidth: p.defaultDimensions.width, packageHeight: p.defaultDimensions.height,
    dimensionUnit: p.dimensionUnit ?? "INCH", weightUnit: p.weightUnit ?? "POUND", spu: "", spuId: "", hasSkuPackage: 0,
    searchTerms: rich?.searchTerms ?? [], productHighlights: rich?.productHighlights ?? [],
    productAttributes: buildProductAttributes(schema, data.attributes || {}), brandId: "0", brandInfo: JSON.stringify({ name: "No Brand", id: "0" }),
    option1: JSON.stringify({ [sales.color.attrId]: sales.color.attrName }), option1Value: JSON.stringify(colorVals.map((v) => ({ [v.key]: v.name }))),
    option2: JSON.stringify({ [sales.size.attrId]: sales.size.attrName }), option2Value: JSON.stringify(sizeVals.map((v) => ({ [v.key]: v.name }))),
    variation,
    mainImage: [...(showcaseUrl ? [showcaseUrl] : []), ...mainUrls].join("|"), // showcase đứng đầu = ảnh Main
    // custom_value phải khớp TÊN trong option1Value (chuẩn hoá theo valueList), không phải tên gốc SHEIN.
    skuImgs: JSON.stringify(colors.map((_c, i) => ({ attrName: sales.color.attrName, img_url: variantUrls[i].join("|"), custom_value: colorVals[i].name }))),
    sizeChart: sizeChartUrl, productCertifications: "[]", sourceUrl: data.url || "",
  };
  // Tên màu/size gửi theo valueList TikTok (vd "black" → "Black") để attrs khớp option values.
  for (const v of payload.variation) { v.attrs = [colorVals[colors.indexOf(v.option1)].name, sizeVals[sizes.indexOf(v.option2)].name]; v.option1 = v.attrs[0]; v.option2 = v.attrs[1]; }

  if (opts?.dryRun) { console.log(`🧪 [API] dry-run: payload sẵn sàng (${variation.length} variant, ${Math.round((Date.now() - t0) / 1000)}s)`); return { payload }; }
  const res = await fourSellerPost<{ code?: number; listingId?: string | number; errorMessage?: string | null }>(principal, "/api/listing/tiktok/publish", payload);
  if (!res?.listingId) throw new Error(`Publish API lỗi: ${res?.errorMessage ?? JSON.stringify(res)}`);
  console.log(`✅ [API] listingId=${res.listingId} · ${Math.round((Date.now() - t0) / 1000)}s`);
  return { listingId: String(res.listingId), payload };
};
