/**
 * Cào DANH SÁCH sản phẩm của nguyên 1 store SHEIN bằng Kiki.
 *
 * API RapidAPI không list được sản phẩm theo store (endpoint hỏng), nên cách
 * khả thi: mở trang store trong Kiki → auto-scroll → THU 2 nguồn:
 *   1. Intercept JSON nội bộ SHEIN trả khi load/scroll (giàu data: rating,
 *      review count, giá) — nguồn chính để thống kê.
 *   2. DOM fallback: gom link sản phẩm (...-p-<id>.html) để chắc chắn có URL.
 *
 * Trả về list sản phẩm + chỉ số (rating, reviewCount≈sold, giá) → user lọc.
 */
import type { Page } from "playwright-core";
import { ensureNoCaptcha, type CaptchaOptions } from "./captcha";

export interface StoreProduct {
  goodsId: string;
  goodsSn?: string;
  name?: string;
  image?: string;
  url?: string;
  price: number | null;
  retailPrice: number | null;
  discountPct: number | null;
  /** Số review — proxy cho lượng bán */
  reviewCount: number;
  rating: number | null;
  catId?: string;
  catName?: string;
}

export interface CrawlStoreOptions {
  maxProducts?: number;
  captcha?: CaptchaOptions;
  onLog?: (msg: string) => void;
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? v.amount ?? v.usdAmount ?? v.value : v);
  return Number.isFinite(n) ? n : null;
};
const httpsImg = (u?: string | null): string => {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
};

/** Tìm đệ quy các mảng object "giống sản phẩm" trong 1 JSON bất kỳ. */
function findProductArrays(obj: any, out: any[][], depth = 0): void {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === "object" && obj[0] && (obj[0].goods_id || obj[0].goodsId || obj[0].goods_sn)) {
      out.push(obj);
    }
    for (const it of obj) findProductArrays(it, out, depth + 1);
    return;
  }
  for (const k of Object.keys(obj)) findProductArrays(obj[k], out, depth + 1);
}

function normItem(it: any, host: string): StoreProduct | null {
  const goodsId = String(it.goods_id ?? it.goodsId ?? "");
  if (!goodsId) return null;
  const price = num(it.salePrice ?? it.sale_price ?? it.price ?? it.discountPrice);
  const retail = num(it.retailPrice ?? it.retail_price);
  const discountPct =
    price !== null && retail !== null && retail > 0 && price < retail
      ? Math.round((1 - price / retail) * 100)
      : num(it.unit_discount);
  const urlName = it.goods_url_name || it.goodsUrlName;
  const url = it.productUrl
    ? httpsImg(it.productUrl)
    : `https://${host}/${urlName ? String(urlName).replace(/\s+/g, "-") + "-" : ""}p-${goodsId}.html`;
  return {
    goodsId,
    goodsSn: it.goods_sn ?? it.goodsSn,
    name: it.goods_name ?? it.goodsName ?? it.title,
    image: httpsImg(it.goods_img || it.goodsImage || it.image),
    url,
    price,
    retailPrice: retail,
    discountPct,
    reviewCount: Number(it.comment_num ?? it.commentNum ?? it.comment_num_show ?? 0) || 0,
    rating: num(it.comment_rank_average ?? it.commentRankAverage ?? it.rating),
    catId: it.cat_id ? String(it.cat_id) : undefined,
    catName: it.cate_name ?? it.cateName,
  };
}

async function humanScroll(page: Page): Promise<void> {
  const step = 600 + Math.floor(Math.random() * 500);
  await page.mouse.wheel(0, step).catch(() => {});
  await page.waitForTimeout(700 + Math.floor(Math.random() * 900));
  // thỉnh thoảng cuộn ngược nhẹ cho giống người
  if (Math.random() < 0.25) {
    await page.mouse.wheel(0, -150).catch(() => {});
    await page.waitForTimeout(400);
  }
}

export async function crawlStore(page: Page, opts: CrawlStoreOptions = {}): Promise<StoreProduct[]> {
  const log = opts.onLog ?? (() => {});
  const maxProducts = opts.maxProducts ?? 300;
  const host = (() => {
    try {
      return new URL(page.url()).host || "us.shein.com";
    } catch {
      return "us.shein.com";
    }
  })();

  const map = new Map<string, StoreProduct>();

  // 1. Intercept JSON nội bộ SHEIN
  const onResponse = async (res: any) => {
    try {
      const url = res.url();
      if (!/shein|ltwebstatic|sheinsz/i.test(url)) return;
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;
      const data = await res.json().catch(() => null);
      if (!data) return;
      const arrays: any[][] = [];
      findProductArrays(data, arrays);
      for (const arr of arrays) {
        for (const raw of arr) {
          const p = normItem(raw, host);
          if (!p) continue;
          const cur = map.get(p.goodsId);
          // JSON (giàu data: giá/review/rating) LUÔN thắng placeholder DOM (price=null).
          // Không đè 1 JSON tốt bằng JSON khác (giữ bản đầu) — chỉ nâng cấp placeholder null.
          if (!cur || (cur.price == null && p.price != null)) map.set(p.goodsId, p);
        }
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResponse);

  try {
    // Listener gắn ở trên, NHƯNG caller đã goto trang trước đó → JSON sản phẩm trang đầu bắn
    // TRƯỚC khi listener bật (mất giá/review). Keyword ít kết quả không scroll ra JSON mới →
    // rơi hết về DOM fallback (price=null). Reload 1 lần để JSON trang đầu bắn LẠI với listener đang bật.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await ensureNoCaptcha(page, opts.captcha);
    await page.waitForTimeout(2000);

    let stagnant = 0;
    let lastCount = 0;
    let rounds = 0;
    const maxRounds = 200;
    while (map.size < maxProducts && stagnant < 5 && rounds < maxRounds) {
      rounds++;
      await ensureNoCaptcha(page, opts.captcha);
      await humanScroll(page);

      // 2. DOM fallback: gom link sản phẩm còn thiếu
      try {
        const links: string[] = await page.evaluate(`(function(){
          var out=[]; var as=document.querySelectorAll('a[href*="-p-"]');
          for (var i=0;i<as.length;i++){ var h=as[i].getAttribute('href')||''; if(/-p-\\d+\\.html/.test(h)) out.push(h); }
          return out;
        })()`);
        for (const href of links) {
          const m = href.match(/-p-(\d+)\.html/);
          if (!m) continue;
          const gid = m[1];
          if (!map.has(gid)) {
            const full = href.startsWith("http") ? href : `https://${host}${href.startsWith("/") ? "" : "/"}${href}`;
            map.set(gid, {
              goodsId: gid,
              url: full,
              price: null,
              retailPrice: null,
              discountPct: null,
              reviewCount: 0,
              rating: null,
            });
          }
        }
      } catch {
        /* ignore DOM fallback errors */
      }

      if (map.size === lastCount) stagnant++;
      else {
        stagnant = 0;
        log(`Đã thu ${map.size} sản phẩm…`);
      }
      lastCount = map.size;
    }
    log(`Hoàn tất crawl store: ${map.size} sản phẩm (rounds=${rounds}).`);
  } finally {
    page.off("response", onResponse);
  }

  return Array.from(map.values()).slice(0, maxProducts);
}
