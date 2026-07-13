/**
 * publishScheduler — đăng video NHỎ GIỌT lên TikTok (triết lý giống dripPublisher):
 *   - Mỗi shop tối đa `perShopPerDay` video/24h (mặc định 5).
 *   - Giữa 2 lần đăng của CÙNG shop phải cách ≥ `minGapMin` phút ± jitter (mặc định ~2h)
 *     → 5 video rải đều trong ngày, không dồn cục (tránh bị chấm điểm hành vi bất thường).
 *   - Chỉ đăng trong khung giờ [hourFrom, hourTo) giờ máy (mặc định 8h–23h).
 *   - Mỗi tick chỉ đăng 1 video/shop, các shop chạy TUẦN TỰ (1 profile Kiki 1 lúc).
 *
 * Shop phải có Kiki profile (bảng shop_tiktok_profile — set ở tab TikTok Edit của admin).
 */
import cron from "node-cron";
import { VideoDb } from "../../state/videoDb";
import { EditDb } from "../../services/tiktok/editDb";
import { publishVideo } from "./publishVideo";
import { buildCaption } from "./buildCaption";

export interface SchedulerConfig {
  perShopPerDay: number;
  minGapMin: number;
  jitterMin: number;
  hourFrom: number;
  hourTo: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  perShopPerDay: 5,
  minGapMin: 120,   // ~2h giữa 2 video cùng shop
  jitterMin: 30,    // ± 30 phút để giờ đăng không đều tăm tắp
  hourFrom: 8,
  hourTo: 23,
};

const DAY_MS = 86_400_000;

export type SkipReason = "quota" | "gap" | "no-profile" | "no-video";

export interface ShopDecision {
  shop: string;
  eligible: boolean;
  reason?: SkipReason;
  postedToday: number;
  minutesUntilNext?: number;
  video?: { id: number; title: string };
}

/**
 * Quyết định 1 shop có được đăng lúc `now` không (PURE — unit-test được).
 * jitter truyền vào (thay vì random trong hàm) để test tất định.
 */
export function decideShop(args: {
  shop: string;
  now: number;
  postedToday: number;
  lastPostedAt: number | null;
  hasProfile: boolean;
  nextVideo?: { id: number; title: string };
  cfg: SchedulerConfig;
  jitterMin: number;
}): ShopDecision {
  const { shop, now, postedToday, lastPostedAt, hasProfile, nextVideo, cfg } = args;
  const base: ShopDecision = { shop, eligible: false, postedToday };

  if (!hasProfile) return { ...base, reason: "no-profile" };
  if (!nextVideo) return { ...base, reason: "no-video" };
  if (postedToday >= cfg.perShopPerDay) return { ...base, reason: "quota" };

  if (lastPostedAt) {
    const gapMs = (cfg.minGapMin + args.jitterMin) * 60_000;
    const waited = now - lastPostedAt;
    if (waited < gapMs) {
      return { ...base, reason: "gap", minutesUntilNext: Math.ceil((gapMs - waited) / 60_000), video: nextVideo };
    }
  }
  return { shop, eligible: true, postedToday, video: nextVideo };
}

/** Trong khung giờ cho phép đăng? */
export const inPostingWindow = (date: Date, cfg: SchedulerConfig): boolean => {
  const h = date.getHours();
  return h >= cfg.hourFrom && h < cfg.hourTo;
};

export interface TickResult {
  ranAt: number;
  inWindow: boolean;
  decisions: ShopDecision[];
  published: { shop: string; videoId: number }[];
  failed: { shop: string; videoId: number; error: string }[];
}

/** Chạy 1 tick: mỗi shop đủ điều kiện đăng đúng 1 video. dryRun = không bấm Post. */
export async function runPublishTick(opts: {
  cfg?: Partial<SchedulerConfig>;
  dryRun?: boolean;
  onLog?: (m: string) => void;
} = {}): Promise<TickResult> {
  const cfg = { ...DEFAULT_SCHEDULER, ...opts.cfg };
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const now = Date.now();
  const result: TickResult = { ranAt: now, inWindow: inPostingWindow(new Date(now), cfg), decisions: [], published: [], failed: [] };

  if (!result.inWindow) {
    log(`⏰ Ngoài khung giờ đăng (${cfg.hourFrom}h–${cfg.hourTo}h) → bỏ tick.`);
    return result;
  }

  const vdb = new VideoDb();
  const edb = new EditDb();
  try {
    const shops = vdb.shopsWithReady();
    if (!shops.length) { log(`📭 Không shop nào có video ready.`); return result; }

    for (const shop of shops) {
      const profile = edb.getProfile(shop);
      const next = vdb.nextReadyForShop(shop);
      const d = decideShop({
        shop, now,
        postedToday: vdb.postedTodayCount(shop, now - DAY_MS),
        lastPostedAt: vdb.lastPostedAt(shop),
        hasProfile: !!profile,
        nextVideo: next ? { id: next.id, title: next.title } : undefined,
        cfg,
        jitterMin: Math.round((Math.random() * 2 - 1) * cfg.jitterMin), // ±jitter
      });
      result.decisions.push(d);

      if (!d.eligible) {
        const why = {
          quota: `đủ quota ${d.postedToday}/${cfg.perShopPerDay} hôm nay`,
          gap: `chờ thêm ${d.minutesUntilNext}′ (giãn cách)`,
          "no-profile": `chưa map Kiki profile (tab TikTok Edit)`,
          "no-video": `không còn video ready`,
        }[d.reason!];
        log(`⏭️ ${shop}: ${why}`);
        continue;
      }

      // Đăng 1 video của shop này
      const row = vdb.get(d.video!.id)!;
      log(`\n🚀 ${shop}: đăng video #${row.id} — ${row.title.slice(0, 45)} (${d.postedToday + 1}/${cfg.perShopPerDay} hôm nay)`);
      try {
        const script = row.script_json ? JSON.parse(row.script_json) : null;
        const r = await publishVideo({
          profileId: profile!,
          videoId: row.id,
          videoFile: row.file!,
          caption: buildCaption({ title: row.title, seed: row.seed, script }),
          productId: row.product_id,
          dryRun: opts.dryRun,
          onLog: log,
        });
        if (r.posted) {
          vdb.markPosted(row.id);
          result.published.push({ shop, videoId: row.id });
        } else {
          log(`   🧪 Dry-run — không đánh dấu posted.`);
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        vdb.setPostError(row.id, msg);      // giữ status=ready → tick sau thử lại
        result.failed.push({ shop, videoId: row.id, error: msg });
        log(`   ❌ ${shop} #${row.id}: ${msg}`);
      }
    }
    return result;
  } finally {
    vdb.close();
    edb.close();
  }
}

/* ── Cron: mỗi 25 phút thức dậy 1 lần, tick sẽ tự lọc quota/giãn cách/khung giờ ── */

let autoEnabled = false;
let ticking = false;

export const isAutoPublishOn = (): boolean => autoEnabled;

export function setAutoPublish(on: boolean): void {
  autoEnabled = on;
  console.log(`📅 Auto-publish video: ${on ? "BẬT" : "TẮT"}`);
}

export function schedulePublishCron(): void {
  cron.schedule("*/25 * * * *", async () => {
    if (!autoEnabled || ticking) return;
    ticking = true;
    try {
      await runPublishTick({ onLog: (m) => console.log(m) });
    } catch (e: any) {
      console.error(`❌ [PublishTick] ${e?.message ?? e}`);
    } finally {
      ticking = false;
    }
  });
  console.log("⏰ Cron auto-publish video đã đăng ký (mỗi 25′, mặc định TẮT — bật ở /admin/videos).");
}

/** Trạng thái quota hiện tại của từng shop (cho UI). */
export function publishStatus(cfg: SchedulerConfig = DEFAULT_SCHEDULER): {
  shop: string; postedToday: number; quota: number; ready: number;
  profile: string | null; lastPostedAt: number | null; minutesUntilNext: number;
}[] {
  const vdb = new VideoDb();
  const edb = new EditDb();
  try {
    const now = Date.now();
    return vdb.shopsWithReady().map((shop) => {
      const last = vdb.lastPostedAt(shop);
      const waitMs = last ? Math.max(0, cfg.minGapMin * 60_000 - (now - last)) : 0;
      return {
        shop,
        postedToday: vdb.postedTodayCount(shop, now - DAY_MS),
        quota: cfg.perShopPerDay,
        ready: vdb.list({ shop, status: "ready", limit: 999 }).length,
        profile: edb.getProfile(shop),
        lastPostedAt: last,
        minutesUntilNext: Math.ceil(waitMs / 60_000),
      };
    });
  } finally {
    vdb.close();
    edb.close();
  }
}
