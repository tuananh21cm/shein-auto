/**
 * detailSignals — bắt các tín hiệu KIỂM ĐỊNH SÂU từ BFF trang detail SHEIN (qua Kiki),
 * bổ sung cho attachStatsCapture (sold/rating) + attachRankCapture (rank).
 *
 * Nguồn:
 *   realtime_data        → ship local/inter (shippingDayPercentDesc, "Shipped by sea
 *                          35-42 Business Days"), isSupportQuickShip, mallCode, returnType
 *   static_data_v2       → sizeInfo (đếm dòng → có/không size chart), material attr_info
 *   buyer_show_floor     → buyerShowTotal (UGC để làm content)
 *   comment / review BFF → true-to-size % (regex trên text — endpoint chưa cố định)
 */
import type { Page } from "playwright-core";

export interface DetailSignals {
  shipDaysMin: number | null;   // số business days nhỏ nhất ước tính
  fastSharePercent: number | null; // % đơn ≤ N ngày
  seaShipping: boolean;         // có lựa chọn "Shipped by sea" (inter)
  quickShip: boolean;
  mallCode: string | null;
  returnType: string | null;
  hasSizeChart: boolean;
  sizeChartRows: number;
  material: string | null;      // vd "95% Polyester, 5% Elastane"
  ugcCount: number | null;
  trueToSize: number | null;    // % (NULL = không lấy được)
}

export interface DetailCapture {
  signals: DetailSignals;
  detach: () => void;
}

function deepFind(o: any, key: string, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 8) return undefined;
  if (o[key] !== undefined && o[key] !== null && o[key] !== "") return o[key];
  for (const k of Object.keys(o)) {
    const r = deepFind(o[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** "60.9% are ≤ 6 business days" → {percent:60.9, days:6}. "35-42 Business Days" → {days:35}. */
function parseShipText(text: string): { percent: number | null; days: number | null } {
  const pPercent = text.match(/([\d.]+)\s*%/);
  const pDaysLe = text.match(/≤?\s*<?b?>?\s*(\d+)\s*<?\/?b?>?\s*business days/i);
  const pRange = text.match(/(\d+)\s*-\s*(\d+)\s*business days/i);
  const days = pDaysLe ? Number(pDaysLe[1]) : pRange ? Number(pRange[1]) : null;
  return { percent: pPercent ? Number(pPercent[1]) : null, days };
}

export function attachDetailCapture(page: Page): DetailCapture {
  const signals: DetailSignals = {
    shipDaysMin: null, fastSharePercent: null, seaShipping: false, quickShip: false,
    mallCode: null, returnType: null, hasSizeChart: false, sizeChartRows: 0,
    material: null, ugcCount: null, trueToSize: null,
  };

  const onResp = async (res: any) => {
    try {
      const url = res.url();
      if (!/bff-api\/product|comment|review/i.test(url)) return;
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;
      const text = await res.text().catch(() => "");
      if (!text) return;

      // true-to-size: regex trên raw text (endpoint review chưa cố định)
      if (signals.trueToSize === null) {
        const m =
          text.match(/true\s*to\s*size[^%{}]{0,40}?([\d.]+)\s*%/i) ||
          text.match(/([\d.]+)\s*%[^%{}]{0,40}?true\s*to\s*size/i) ||
          text.match(/"(?:trueToSize|true_to_size|fitPercent)"\s*:\s*"?([\d.]+)/i);
        if (m) {
          const v = Number(m[1]);
          if (Number.isFinite(v) && v > 0 && v <= 100) signals.trueToSize = v;
        }
      }

      let j: any;
      try { j = JSON.parse(text); } catch { return; }
      const info = j?.info ?? j;

      // realtime_data → shipping / mall / return
      if (/realtime_data/.test(url)) {
        if (/Shipped by sea/i.test(text)) signals.seaShipping = true;
        const quick = deepFind(info, "isSupportQuickShip");
        if (quick === "1" || quick === 1) signals.quickShip = true;
        const mall = deepFind(info, "selectedMallCode") ?? deepFind(info, "mallCode");
        if (mall != null && signals.mallCode === null) signals.mallCode = String(mall);
        const ret = deepFind(info, "returnType");
        if (ret != null) signals.returnType = String(ret);
        // gom mọi mô tả ship → lấy days nhỏ nhất + % nhanh
        for (const m of text.matchAll(/([^"<>]*business days[^"<>]*)/gi)) {
          const { percent, days } = parseShipText(m[1]);
          if (days != null && (signals.shipDaysMin === null || days < signals.shipDaysMin)) {
            signals.shipDaysMin = days;
            if (percent != null) signals.fastSharePercent = percent;
          }
        }
      }

      // static_data_v2 → size chart + material
      if (/static_data_v2/.test(url)) {
        const sizeArr = deepFind(info, "sizeInfo");
        if (Array.isArray(sizeArr) && sizeArr.length) {
          signals.hasSizeChart = true;
          signals.sizeChartRows = sizeArr.length;
        }
        if (!signals.material) {
          const attrInfo = deepFind(info, "attribute_info");
          if (Array.isArray(attrInfo)) {
            const mat = attrInfo.find((a: any) =>
              /material|composition|fabric|content/i.test(String(a?.attr_name ?? a?.name ?? ""))
            );
            const val = mat?.attr_value ?? mat?.value;
            if (val) signals.material = String(val).slice(0, 120);
          }
        }
      }

      // buyer show → UGC count
      if (/buyer_show_floor/.test(url)) {
        const total = deepFind(info, "buyerShowTotal");
        if (total != null) signals.ugcCount = Number(total) || 0;
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", onResp);
  return { signals, detach: () => page.off("response", onResp) };
}

/** DOM fallback đọc "True to Size 85%" ở mục review nếu BFF không có. */
export async function readTrueToSizeDom(page: Page): Promise<number | null> {
  try {
    const val = await page.evaluate(`(function(){
      var els = document.querySelectorAll('div,span,p,section');
      for (var i=0;i<els.length;i++){
        var t = (els[i].textContent||'');
        if (/true to size/i.test(t)) {
          var m = t.match(/true\\s*to\\s*size[^%]{0,40}?(\\d{1,3})\\s*%/i) || t.match(/(\\d{1,3})\\s*%[^%]{0,40}?true\\s*to\\s*size/i);
          if (m) return Number(m[1]);
        }
      }
      return null;
    })()`);
    const n = Number(val);
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
  } catch {
    return null;
  }
}
