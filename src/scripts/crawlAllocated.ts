/**
 * crawlAllocated — tự động cào JSON listing cho sản phẩm ĐÃ PHÂN BỔ của 1 shop.
 * Đọc shop_allocation (status='allocated') → với mỗi sp: Kiki cào URL SHEIN → full JSON →
 * ghi vào baseSheinAutoDir/<shop>/ (worker sẽ list) → đánh dấu status='crawled'.
 *
 * Usage: npx tsx src/scripts/crawlAllocated.ts "<shop>" [N]    (N sp, mặc định 10 = nhịp ngày)
 *
 * ⚠️ Bật Kiki (localhost:8000). Mỗi sp ~30-60s + có thể gặp captcha (giải thủ công trong cửa sổ Kiki).
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../config";
import { readKikiConfig } from "../services/kiki/config";
import { scrapeBatchViaKiki, dispatchScrapedData } from "../core/scrapeViaKiki";
import { scrapeBatchViaChrome } from "../core/scrapeViaChrome";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

const main = async () => {
  const argv = process.argv.slice(2);
  const n = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 10;
  const shopArg = argv.join(" ").trim();
  if (!shopArg) return out({ ok: false, error: 'Thiếu shop. Dùng: npx tsx src/scripts/crawlAllocated.ts "MaeBLa" 10' });

  const baseDir = config.baseSheinAutoDir;
  if (!baseDir) return out({ ok: false, error: "BASE_SHEINAUTO_DIR chưa set trong .env" });

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"));
  const shopRow = db.prepare("SELECT DISTINCT shop FROM shop_allocation WHERE shop LIKE '%'||?||'%' LIMIT 1").get(shopArg) as any;
  if (!shopRow) { db.close(); return out({ ok: false, error: `Không có sp phân bổ cho shop "${shopArg}". Chạy shopAllocate trước.` }); }
  const shop = shopRow.shop;

  // BACKEND: Chrome thật (CDP) hay Kiki. Bật Chrome bằng CRAWL_BACKEND=chrome hoặc cờ --chrome.
  const useChrome = (process.env.CRAWL_BACKEND || "").toLowerCase() === "chrome" || process.argv.includes("--chrome");
  const cdpUrl = process.env.CHROME_CDP || "http://127.0.0.1:9222"; // 127.0.0.1 (tránh localhost→::1 IPv6 refused)

  // Profile Kiki RIÊNG của shop (chỉ cần khi backend Kiki).
  let profileId = "";
  if (!useChrome) {
    const pr = db.prepare("SELECT kiki_profile FROM shop_niche WHERE shop=? AND kiki_profile IS NOT NULL AND kiki_profile!='' LIMIT 1").get(shop) as any;
    profileId = pr?.kiki_profile || readKikiConfig().profiles[0]?.id || "";
    if (!profileId) { db.close(); return out({ ok: false, error: `Shop ${shop} chưa gán kiki_profile (shop_niche) và config/kiki.json trống.` }); }
  }

  // Lấy cả 'allocated' (chưa cào) lẫn 'recrawl' (cào lần trước thiếu size_chart → hàng đợi cào lại).
  const items = db.prepare(
    `SELECT goods_id, name, url, status FROM shop_allocation
     WHERE shop=? AND status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
     ORDER BY (status='recrawl') DESC, opportunity_score DESC LIMIT ?`
  ).all(shop, n) as any[];
  if (!items.length) { db.close(); return out({ ok: false, error: `Không có sp 'allocated'/'recrawl' cho ${shop}.` }); }

  const markCrawled = db.prepare("UPDATE shop_allocation SET status='crawled' WHERE goods_id=?");
  const markRecrawl = db.prepare("UPDATE shop_allocation SET status='recrawl' WHERE goods_id=?");
  const nameById: Record<string, string> = {};
  const statusById: Record<string, string> = {};
  for (const it of items) { nameById[it.goods_id] = it.name; statusById[it.goods_id] = it.status; }
  const results: any[] = [];

  // onProduct: ghi JSON + mark crawled/recrawl NGAY sau mỗi sp (chung cho cả Chrome lẫn Kiki).
  const onProduct = async (goodsId: string, data: any, error?: string) => {
    const nm = (nameById[goodsId] || "").slice(0, 45);
    if (data) {
      const sc = (data as any).size_chart;
      const hasSize = !!(sc && ((sc.sections && sc.sections.length) || (sc.data && sc.data.length)));
      if (!hasSize && statusById[goodsId] !== "recrawl") {
        // Lần đầu thiếu size_chart (SHEIN có thể ẩn khi nghi bot) → KHÔNG ghi JSON, đưa vào HÀNG ĐỢI cào lại.
        markRecrawl.run(goodsId);
        results.push({ goods_id: goodsId, name: nm, ok: false, requeued: true, reason: "thiếu size_chart → recrawl" });
      } else {
        // Có size_chart HOẶC đã retry (recrawl) vẫn thiếu → chấp nhận: ghi JSON + đánh dấu crawled.
        const written = await dispatchScrapedData(baseDir, data, [shop]);
        markCrawled.run(goodsId);
        results.push({ goods_id: goodsId, name: nm, ok: true, file: written[0]?.file, colors: data.listing_variations?.colors?.length, images: data.product_images?.length, sizeChart: hasSize ? "có" : "KHÔNG (đã retry, chấp nhận)" });
      }
    } else {
      results.push({ goods_id: goodsId, name: nm, ok: false, error });
    }
  };

  const batchItems = items.map((it) => ({ goodsId: it.goods_id, url: it.url }));
  if (useChrome) {
    console.error(`  [BACKEND: CHROME ${cdpUrl}]`);
    await scrapeBatchViaChrome({ items: batchItems, cdpUrl, onLog: (m) => console.error("  " + m), onProduct });
  } else {
    console.error(`  [BACKEND: KIKI ${profileId.slice(0, 12)}]`);
    await scrapeBatchViaKiki({ items: batchItems, profileId, onLog: (m) => console.error("  " + m), onProduct });
  }

  db.close();
  const okN = results.filter((r) => r.ok).length;
  const requeued = results.filter((r) => r.requeued).length;
  const failed = results.length - okN - requeued;
  out({ ok: true, shop, backend: useChrome ? "chrome" : "kiki", crawled: okN, requeued, failed, baseDir, results });
};

// process.exit ép thoát: backend Chrome (connectOverCDP) giữ websocket mở → Node ko tự thoát.
//   Thoát Node KHÔNG đóng Chrome (Chrome là process riêng). Kiki path cũng an toàn (đã close trước đó).
main()
  .then(() => process.exit(0))
  .catch((e) => {
    out({ ok: false, error: String(e?.message ?? e) });
    process.exit(1);
  });
