/**
 * rankTracking — theo dõi bestseller rank + rank_movement per category qua Apify
 * (actor jungle_synthesizer/shein-new-arrivals-bestsellers-trend-scraper — actor duy
 * nhất giữ state giữa các lần chạy → có rank_movement + first_seen_date thật).
 *
 * Thay vai trò của: (1) Kalodata demand ngoài (đã bỏ), (2) phần rank enrich của Kiki
 * (đã skip). Rank movement = "đạo hàm demand" — SP đang leo hạng là SP đang bán chạy
 * THẬT trên SHEIN bất kể review cũ mới.
 *
 * Data đổ vào `shein_rank_tracking` (migration v14). Consumers:
 *   - enrichCandidatesApi: gắn rank_text cho research candidate (không cần browser).
 *   - (mở rộng sau) demand blend / lifecycle agent.
 *
 * Input actor để NGUYÊN VĂN trong config/apify.json → rankInput — chỉnh theo schema
 * thật của actor trên console.apify.com (không hardcode trong code vì actor bên thứ 3
 * đổi schema không báo).
 */
import cron, { type ScheduledTask } from "node-cron";
import { getDb } from "../state/db";
import { apifyConfig } from "../config/appConfig";
import { runActorAndGetItems, apifyToken } from "../services/apify/client";

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Parse linh hoạt 1 item output actor → row shein_rank_tracking. Null = không nhận diện được. */
export function parseRankItem(it: Record<string, any>): {
  goodsId: string; rank: number | null; rankMovement: number | null;
  firstSeen: string | null; category: string; name: string;
  price: number | null; discountPct: number | null; url: string; image: string;
} | null {
  // goods_id: field trực tiếp hoặc moi từ URL -p-<id>.html
  let gid = String(it.goods_id ?? it.goodsId ?? it.product_id ?? it.productId ?? "").trim();
  const url = String(it.url ?? it.product_url ?? it.productUrl ?? it.link ?? "");
  if (!/^\d{5,}$/.test(gid)) {
    const m = url.match(/-p-(\d{5,})\.html/) ?? url.match(/goods_id=(\d{5,})/);
    gid = m ? m[1] : "";
  }
  if (!/^\d{5,}$/.test(gid)) return null;

  const numOrNull = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    goodsId: gid,
    rank: numOrNull(it.rank ?? it.position ?? it.rank_position),
    rankMovement: numOrNull(it.rank_movement ?? it.rankMovement ?? it.movement ?? it.rank_change),
    firstSeen: (it.first_seen_date ?? it.firstSeenDate ?? it.first_seen ?? null) as string | null,
    category: String(it.category ?? it.category_name ?? it.categoryUrl ?? it.feed ?? "").slice(0, 200),
    name: String(it.name ?? it.title ?? it.product_name ?? "").slice(0, 300),
    price: numOrNull(it.price ?? it.sale_price ?? it.salePrice),
    discountPct: numOrNull(it.discount_pct ?? it.discount ?? it.discountPercent),
    url: url.slice(0, 500),
    image: String(it.image ?? it.image_url ?? it.imageUrl ?? "").slice(0, 500),
  };
}

export interface RankTrackingResult { items: number; saved: number; unparsed: number; day: string }

export async function runRankTrackingOnce(onLog?: (m: string) => void): Promise<RankTrackingResult> {
  const log = onLog ?? ((m: string) => console.log("[rank-track]", m));
  const cfg = apifyConfig();
  if (!cfg.enabled || !cfg.rankActorId) throw new Error("Apify rank tracking tắt (config/apify.json)");

  const day = todayStr();
  const items = await runActorAndGetItems<Record<string, any>>(
    cfg.rankActorId,
    cfg.rankInput ?? {},
    { timeoutMinutes: cfg.runTimeoutMinutes ?? 20, onLog: log }
  );

  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO shein_rank_tracking (
      day, source, category, goods_id, rank, rank_movement, first_seen_date,
      name, price, discount_pct, url, image, captured_at
    ) VALUES (?, 'apify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source, category, goods_id) DO UPDATE SET
      rank=excluded.rank, rank_movement=excluded.rank_movement,
      first_seen_date=excluded.first_seen_date, name=excluded.name,
      price=excluded.price, discount_pct=excluded.discount_pct,
      url=excluded.url, image=excluded.image, captured_at=excluded.captured_at
  `);
  const now = Date.now();
  let saved = 0;
  let unparsed = 0;
  db.transaction(() => {
    for (const it of items) {
      const p = parseRankItem(it);
      if (!p) { unparsed++; continue; }
      ins.run(day, p.category, p.goodsId, p.rank, p.rankMovement, p.firstSeen,
        p.name, p.price, p.discountPct, p.url, p.image, now);
      saved++;
    }
  })();
  // No silent drops: unparsed cao = schema actor đổi → phải chỉnh parseRankItem/rankInput.
  log(`✅ Rank tracking ${day}: ${saved} rows lưu · ${unparsed} item không parse được${unparsed > items.length * 0.3 ? " ⚠️ >30% — schema actor có thể đã đổi!" : ""}`);
  return { items: items.length, saved, unparsed, day };
}

/** Rank mới nhất của 1 goods_id (bất kể category — lấy rank tốt nhất ngày gần nhất). */
export function latestRankInfo(goodsId: string): {
  rank: number | null; rankMovement: number | null; category: string; day: string;
} | null {
  try {
    const r = getDb().prepare(`
      SELECT day, category, rank, rank_movement FROM shein_rank_tracking
      WHERE goods_id = ? ORDER BY day DESC, (rank IS NULL), rank ASC LIMIT 1
    `).get(String(goodsId)) as any;
    if (!r) return null;
    return { rank: r.rank ?? null, rankMovement: r.rank_movement ?? null, category: r.category ?? "", day: r.day };
  } catch { return null; }
}

/* ───────── Scheduler ───────── */
let task: ScheduledTask | null = null;
let running = false;

export function scheduleRankTracking(): void {
  const cfg = apifyConfig();
  if (!cfg.enabled) { console.log("⏰ Rank tracking (Apify): TẮT (apify.json → enabled=false)"); return; }
  if (!apifyToken()) { console.log("⏰ Rank tracking (Apify): TẮT — thiếu APIFY_TOKEN"); return; }
  const expr = cfg.schedule ?? "30 7 * * *";
  if (!cron.validate(expr)) { console.error(`⏰ Rank tracking: lịch không hợp lệ "${expr}"`); return; }
  task?.stop();
  task = cron.schedule(expr, async () => {
    if (running) { console.log("[rank-track] vòng trước chưa xong — bỏ."); return; }
    running = true;
    try { await runRankTrackingOnce(); }
    catch (e: any) { console.error("[rank-track] ✗", e?.message ?? e); }
    finally { running = false; }
  }, cfg.timezone ? { timezone: cfg.timezone } : undefined);
  console.log(`⏰ Rank tracking (Apify): BẬT — ${expr}${cfg.timezone ? ` (${cfg.timezone})` : ""}`);
}
