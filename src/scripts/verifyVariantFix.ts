/**
 * verifyVariantFix — cào lại 1 URL SHEIN qua Kiki (scraper ĐÃ FIX) và kiểm tra
 * các màu có ảnh KHÁC nhau không (bug "variant kẹt" đã hết chưa).
 * Usage: npx tsx src/scripts/verifyVariantFix.ts "<url>" <profileId>
 */
import "dotenv/config";
import { scrapeViaKiki } from "../core/scrapeViaKiki";

const main = async () => {
  const url = process.argv[2];
  const profileId = process.argv[3];
  if (!url || !profileId) {
    console.log('Dùng: npx tsx src/scripts/verifyVariantFix.ts "<url>" <profileId>');
    return;
  }
  const data = await scrapeViaKiki({ url, profileId, onLog: (m) => console.error("  " + m) }).catch((e) => {
    console.error("  ❌ scrapeViaKiki throw:", e?.message ?? e);
    return null;
  });
  if (!data) {
    console.log(JSON.stringify({ ok: false, note: "crawl fail/throw (xem log trên)" }));
    return;
  }
  const colors: string[] = data.listing_variations.colors || [];
  const sigOf = (arr: string[]) => arr.slice(0, 3).join("|");
  const sigs = (data.variant_images || []).map((o: any) => {
    const k = Object.keys(o)[0];
    return sigOf(o[k] || []);
  });
  const uniq = new Set(sigs.filter(Boolean));
  console.log(
    JSON.stringify(
      {
        ok: true,
        name: data.product_name,
        colors: colors.length,
        uniqueImageSets: uniq.size,
        variantStuck: (data as any)._meta?.variantStuck,
        stuckColors: (data as any)._meta?.stuckColors,
        verdict: uniq.size >= Math.max(2, colors.length * 0.6) ? "✅ ĐÃ FIX (ảnh đa dạng)" : "❌ VẪN KẸT",
        sample: colors.slice(0, 5).map((c, i) => ({ color: c, img0: ((data.variant_images[i] as any)?.[c]?.[0] || "").slice(-30) })),
      },
      null,
      1
    )
  );
};

main().catch((e) => console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })));
