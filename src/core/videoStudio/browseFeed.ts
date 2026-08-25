/**
 * browseFeed — "warm up" tài khoản: vào tiktok.com lướt feed như người thật
 * TRƯỚC khi đăng và SAU khi đăng. Mục đích: phiên không chỉ toàn hành vi upload
 * (dấu hiệu bot rõ rệt) mà có cả xem/tương tác.
 *
 * Hành vi mô phỏng: xem mỗi video một khoảng ngẫu nhiên (có video xem lâu, có video
 * lướt nhanh — như người thật), thỉnh thoảng like, thời lượng tổng random.
 * Mọi lỗi ở đây đều NUỐT (best-effort) — warm-up hỏng không được làm hỏng việc đăng.
 */

export interface BrowseOptions {
  /** Số video lướt qua (random trong khoảng). Mặc định 4–9. */
  minVideos?: number;
  maxVideos?: number;
  /** Tỉ lệ like mỗi video (0–1). Mặc định 0.15 (~1/7 video). */
  likeRate?: number;
  onLog?: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

/**
 * Thời gian xem 1 video: đa số 3–12s, thỉnh thoảng (1/5) xem lâu 15–30s
 * — phân bố giống người thật hơn là xem đều tăm tắp.
 */
const watchMs = (): number =>
  Math.random() < 0.2 ? rand(15_000, 30_000) : rand(3_000, 12_000);

export async function browseFeed(page: any, opts: BrowseOptions = {}): Promise<{ watched: number; liked: number }> {
  const log = opts.onLog ?? (() => {});
  const n = randInt(opts.minVideos ?? 4, opts.maxVideos ?? 9);
  const likeRate = opts.likeRate ?? 0.15;
  const out = { watched: 0, liked: 0 };

  try {
    log(`👀 Lướt feed TikTok (${n} video) — warm up tài khoản…`);
    await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(rand(3000, 6000));

    // Đóng popup đăng nhập/cookie nếu có (best-effort)
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("Decline")', 'div[data-e2e="modal-close-inner-button"]']) {
      await page.locator(sel).first().click({ timeout: 2500 }).catch(() => {});
    }

    for (let i = 0; i < n; i++) {
      await sleep(watchMs());
      out.watched++;

      // Like ngẫu nhiên (phím L là shortcut của TikTok web)
      if (Math.random() < likeRate) {
        await page.keyboard.press("KeyL").catch(() => {});
        out.liked++;
        await sleep(rand(600, 1800));
      }

      // Sang video kế: mũi tên xuống (fallback: cuộn chuột)
      await page.keyboard.press("ArrowDown").catch(async () => {
        await page.mouse.wheel(0, 900).catch(() => {});
      });
      await sleep(rand(500, 1500));
    }
    log(`   ✓ Đã xem ${out.watched} video, like ${out.liked}`);
  } catch (e: any) {
    log(`   ⚠️ Warm-up lỗi (bỏ qua, không ảnh hưởng đăng bài): ${e?.message ?? e}`);
  }
  return out;
}
