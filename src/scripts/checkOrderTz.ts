/**
 * checkOrderTz — kéo tổng ĐƠN "hôm nay" theo NHIỀU cách tính ngày (Pacific/Eastern/VN/UTC)
 * để so với số "Today" trên web 4Seller → biết dashboard đang tính đúng giờ chưa.
 *
 * Usage: npx tsx src/scripts/checkOrderTz.ts [--user=tuananh]
 */
import "dotenv/config";
import { getShopList, getSalesByShop } from "../services/fourseller/client";

const dayIn = (tz: string, offset = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() - offset * 864e5));

const main = async () => {
  const user = process.argv.find((a) => a.startsWith("--user="))?.slice(7) || "tuananh";
  const zones = {
    "Pacific (đang dùng)": "America/Los_Angeles",
    Eastern: "America/New_York",
    "Vietnam": "Asia/Bangkok",
    UTC: "UTC",
  };
  console.log("Giờ máy chủ (UTC ms):", new Date().toISOString());
  for (const [label, tz] of Object.entries(zones)) console.log(`  ${label}: hôm nay = ${dayIn(tz)}`);

  const shops = await getShopList(user);
  const ids = (shops.records ?? []).map((s) => s.id).filter((x) => x != null);
  console.log(`\n${ids.length} shop. Tổng ĐƠN "hôm nay" theo từng cách tính ngày:\n`);

  for (const [label, tz] of Object.entries(zones)) {
    const day = dayIn(tz);
    try {
      const rows = await getSalesByShop(user, { startTime: day, endTime: day, shopIds: ids });
      const orders = (rows ?? []).reduce((s, r) => s + (r.totalOrders ?? 0), 0);
      const sales = (rows ?? []).reduce((s, r) => s + (r.totalSales ?? 0), 0);
      const withOrders = (rows ?? []).filter((r) => (r.totalOrders ?? 0) > 0).length;
      console.log(`  ${label.padEnd(20)} (${day}) → ${orders} đơn · $${sales.toFixed(0)} · ${withOrders} shop có đơn`);
    } catch (e: any) {
      console.log(`  ${label.padEnd(20)} (${day}) → LỖI: ${e?.message ?? e}`);
    }
  }
  console.log("\n→ So số nào KHỚP với 'Today' trên web 4Seller: đó là tz 4Seller thực dùng.");
};

main().catch((e) => { console.error("ERR:", e?.message ?? e); process.exit(1); });
