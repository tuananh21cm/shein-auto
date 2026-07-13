/**
 * Gen video hàng loạt cho nhiều shop: đề xuất SP tiềm năng (view/sold) → enqueue.
 * Bỏ qua SP đã có video ready/posted. Queue tự chạy tuần tự (1 render 1 lúc).
 *
 * Usage:
 *   npx tsx src/scripts/genVideosForShops.ts --count=10 --shops="171,172,300"
 *   npx tsx src/scripts/genVideosForShops.ts --count=10           # TẤT CẢ shop có data view
 *
 * --shops nhận số hiệu scan (171, 172…) hoặc tên đầy đủ; khớp lỏng theo chuỗi con.
 */
import "dotenv/config";
import { TiktokDb } from "../services/tiktok/db";
import { EditDb } from "../services/tiktok/editDb";
import { suggestProducts } from "../core/videoStudio/suggestProducts";
import { videoQueue } from "../core/videoStudio/videoQueue";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const main = async () => {
  const count = parseInt(arg("count") ?? "10");
  const filter = (arg("shops") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const tdb = new TiktokDb();
  const edb = new EditDb();
  // Nguồn shop = shop CÓ DATA VIEW ∪ shop ĐÃ MAP Kiki profile. Shop mới (chưa crawl view)
  // vẫn gen được — suggestProducts fallback sang chọn listing active ngẫu nhiên.
  const pool = [...new Set([...tdb.listTrackedShops(), ...edb.allProfiles().map((p) => p.shop)])];
  tdb.close();

  // Lọc theo --shops (khớp chuỗi con, không phân biệt hoa thường)
  const shops = filter.length
    ? pool.filter((s) => filter.some((f) => s.toLowerCase().includes(f.toLowerCase())))
    : pool;

  console.log(`🎬 Gen tối đa ${count} video/shop cho ${shops.length} shop\n`);
  let totalQueued = 0;

  for (const shop of shops) {
    const profile = edb.getProfile(shop);
    if (!profile) {
      console.log(`⏭️  ${shop}: CHƯA map Kiki profile → bỏ qua (gen ra cũng không đăng được)`);
      continue;
    }
    try {
      const sug = await suggestProducts(shop, { limit: count * 3 });
      // Chỉ SP chưa có video (hasVideo=false), lấy top `count` (đã sắp theo tín hiệu mạnh nhất)
      const fresh = sug.items.filter((it) => !it.hasVideo).slice(0, count);
      if (!fresh.length) {
        console.log(`⏭️  ${shop}: không còn SP tiềm năng nào chưa có video`);
        continue;
      }
      const ids = videoQueue.enqueue(
        shop,
        fresh.map((it) => ({
          productId: it.productId, listingId: it.listingId, title: it.title,
          mainImage: it.mainImage, pv: it.pv, orders: it.orders,
        }))
      );
      totalQueued += ids.length;
      console.log(`✅ ${shop}: +${ids.length} video vào queue (từ ${sug.items.length} SP tiềm năng)`);
    } catch (e: any) {
      console.log(`❌ ${shop}: ${e?.message ?? e}`);
    }
  }
  edb.close();

  console.log(`\n🏁 Tổng ${totalQueued} video vào queue. Queue chạy nền (~90s/video → ~${Math.round(totalQueued * 1.5)} phút).`);
  console.log(`   Theo dõi: npx tsx src/scripts/videoQueueStatus.ts`);
  // KHÔNG exit — để queue chạy tiếp trong process này.
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
