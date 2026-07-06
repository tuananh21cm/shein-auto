/**
 * pullCategory — cào DANH SÁCH sp theo NGÁCH (API gốc SHEIN qua Chrome CDP) rồi nạp vào
 * hàng đợi uncrawl (shop_allocation) cho 1 shop. Nguồn field giàu hơn RapidAPI.
 *
 * YÊU CẦU: Chrome mở sẵn --remote-debugging-port=9222 (cùng CDP với autoCrawler),
 * đã đăng nhập/đi qua region US, KHÔNG đang dính captcha.
 *
 * Usage:
 *   # Cào mọi ngách (có selectId) đã gán cho shop:
 *   npx tsx src/scripts/pullCategory.ts <shop>
 *   # Chỉ 1 ngách:
 *   npx tsx src/scripts/pullCategory.ts <shop> --niche=summer-dress
 *   # Ad-hoc theo selectId/URL trực tiếp (không cần sửa research.json):
 *   npx tsx src/scripts/pullCategory.ts <shop> --select=017172961 --niche=women-clothing
 *   # Tuỳ chọn: --scrolls=3 (kéo sâu hơn) --max=240 --min=60 --dry
 */
import "dotenv/config";
import { pullCategoryForShop } from "../core/research/pullMoreViaCategory";

const out = (o: any) => console.log(JSON.stringify(o, null, 1));

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function main() {
  const shop = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!shop) {
    return out({ ok: false, error: "Thiếu <shop>. Usage: pullCategory.ts <shop> [--niche=..] [--select=..] [--scrolls=N] [--max=N] [--min=N] [--dry]" });
  }
  const scrolls = arg("scrolls");
  const max = arg("max");
  const min = arg("min");
  const wait = arg("wait"); // ms chờ giải captcha tay (vd --wait=120000)
  try {
    const res = await pullCategoryForShop({
      shop,
      nicheKey: arg("niche"),
      selectId: arg("select"),
      catId: arg("cat"),
      maxScrolls: scrolls != null ? Number(scrolls) : undefined,
      maxProducts: max != null ? Number(max) : undefined,
      minOpportunity: min != null ? Number(min) : undefined,
      captchaWaitMs: wait != null ? Number(wait) : undefined,
      dryRun: hasFlag("dry"),
      onLog: (m) => console.error(m), // log tiến trình ra stderr, JSON kết quả ra stdout
    });
    out({ ok: true, ...res });
  } catch (e: any) {
    out({ ok: false, error: String(e?.message ?? e) });
    process.exitCode = 1;
  }
}

main();
