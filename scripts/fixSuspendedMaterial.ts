/**
 * Gỡ thuộc tính "Material" khỏi listing TikTok bị suspend "PDP Inconsistent Information" (28/09:
 * Material chọn nhầm thành phần phụ, vd Elastane 1%) rồi đẩy lại qua 4Seller batch-update-listing-attr
 * (endpoint lấy từ bundle web 4Seller: payload [{listingId, productAttributes: JSON-string}]).
 * Sau đó batch-publish để đẩy thay đổi lên TikTok (update-attr một mình chỉ lưu trên 4Seller).
 * Chạy: npx tsx scripts/fixSuspendedMaterial.ts [--limit N] [--apply]   (mặc định chỉ liệt kê)
 */
import fs from "fs";
import { getShopList, getListingPage, getListingDetail, fourSellerPost, fourSellerGet, batchPublish } from "../src/services/fourseller/client";
import { listAccounts } from "../src/state/fourSellerAccounts";

const apply = process.argv.includes("--apply");
const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || Infinity;
const log = "data/fix-suspended-material.jsonl";

(async () => {
  let done = 0;
  for (const a of await listAccounts()) {
    const P = `acct:${a.uid}`;
    let shops: any[] = [];
    try { shops = (await getShopList(P)).records; } catch (e: any) { console.log("❌", a.label, e.message); continue; }
    for (const s of shops) {
      for (let page = 1; done < limit; page++) {
        const pg: any = await getListingPage(P, { shopId: s.id, status: "suspended", pageSize: 50, pageCurrent: page });
        const recs = (pg?.records || []).filter((r: any) => /Inconsistent Information/i.test(r.failedMessage || r.errMsg || ""));
        const batch: { listingId: string; productAttributes: string }[] = [];
        for (const r of recs) {
          if (done + batch.length >= limit) break;
          const x: any = await getListingDetail(P, r.id).then((d: any) => d.data ?? d);
          const attrs: any[] = typeof x.productAttributes === "string" ? JSON.parse(x.productAttributes || "[]") : x.productAttributes || [];
          const kept = attrs.filter((q) => !/^material$/i.test(q.attributeName));
          if (kept.length === attrs.length) continue;
          const mat = attrs.find((q) => /^material$/i.test(q.attributeName))?.values?.map((v: any) => v.valueName).join("/");
          console.log(`${apply ? "✏️" : "👀"} ${s.shopName} | ${r.id} | bỏ Material=${mat} | ${String(r.productName).slice(0, 50)}`);
          batch.push({ listingId: String(r.id), productAttributes: JSON.stringify(kept) });
        }
        if (apply && batch.length) {
          const res = await fourSellerPost<any>(P, "/api/listing/tiktok/batch-update-listing-attr", batch);
          console.log("   → 4Seller:", JSON.stringify(res).slice(0, 200));
          // batch-update-listing-attr CHỈ lưu trên 4Seller (publishStatus "publishable") — đo 28/09: 2 giờ sau
          // 243/243 vẫn suspended. Phải đợi schedule xong rồi batch-publish mới đẩy lên TikTok (không tạo listing mới).
          for (let i = 0; i < 30; i++) {
            const sc: any = await fourSellerGet(P, `/api/listing/tiktok/get-batch-update-schedule?scheduleCode=${encodeURIComponent(String(res))}`).catch(() => null);
            if (sc && sc.succeed + sc.failed >= sc.total) break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          console.log("   → publish:", JSON.stringify(await batchPublish(P, batch.map((b) => b.listingId))));
          for (const b of batch) fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), acct: a.label, shop: s.shopName, listingId: b.listingId, res }) + "\n");
        }
        done += batch.length;
        if (!pg?.records?.length || pg.records.length < 50) break;
      }
      if (done >= limit) break;
    }
    if (done >= limit) break;
  }
  console.log(`${apply ? "Đã gửi" : "Sẽ sửa"}: ${done} listing`);
})();
