/**
 * Signal Store — lưu snapshot research hằng ngày + danh sách candidate.
 * Tầng 2 của Win Intelligence Engine (xem docs/SHEIN-RESEARCH-MAP.md).
 *
 * 3 bảng (migration v5):
 *   research_product   — sp đã chấm điểm theo ngày
 *   research_niche     — rollup nhiệt ngách theo ngày
 *   research_candidate — candidate chọn để đăng, status duyệt 1-click
 */
import { getDb } from "./db";
import { eventBus } from "./eventBus";
import { researchConfig } from "../config/appConfig";

export type CandidateStatus = "new" | "approved" | "queued" | "dismissed";

export interface ProductSnapshot {
  goodsId: string;
  nicheKey: string;
  nicheGroup: string;
  name: string;
  image: string;
  url: string;
  storeCode?: string | null;
  price: number | null;
  retailPrice: number | null;
  discountPct: number | null;
  finalPrice: number | null;
  commentNum: number;
  rating: number | null;
  soldNum?: number | null;
  winScore: number;
  winTier: string;
  marginScore: number;
  opportunityScore: number;
  source: string;
}

export interface NicheSnapshot {
  nicheKey: string;
  nicheGroup: string;
  query: string;
  supplyCount: number;
  avgTopWin: number;
  hotShare: number;
  medianPrice: number | null;
  marginBand: number;
  heatScore: number;
}

export interface Candidate {
  id: string;
  day: string;
  goodsId: string;
  nicheKey: string;
  nicheGroup: string;
  name: string;
  image: string;
  url: string;
  storeCode: string | null;
  price: number | null;
  finalPrice: number | null;
  commentNum: number;
  rating: number | null;
  soldNum: number | null;
  winScore: number;
  winTier: string;
  opportunityScore: number;
  reason: string;
  aiReason: string | null;
  status: CandidateStatus;
  targetShop: string | null;
  soldText: string | null;
  rankText: string | null;
  enrichedAt: number | null;
  createdAt: number;
  updatedAt: number;
  // ── Deep Validation Gate (v8) — optional để dailyResearch khỏi phải set ──
  validationScore?: number | null;
  verdict?: string | null;
  isLocal?: number | null;
  shipMode?: string | null;
  trueToSize?: number | null;
  ugcCount?: number | null;
  ipRisk?: number | null;
  badges?: string[];
  validation?: any;
  validatedAt?: number | null;
}

/** Ngày UTC dạng YYYY-MM-DD. */
export const today = (): string => new Date().toISOString().slice(0, 10);

const candidateRowToObj = (r: any): Candidate => ({
  id: r.id,
  day: r.day,
  goodsId: r.goods_id,
  nicheKey: r.niche_key,
  nicheGroup: r.niche_group,
  name: r.name,
  image: r.image,
  url: r.url,
  storeCode: r.store_code ?? null,
  price: r.price ?? null,
  finalPrice: r.final_price ?? null,
  commentNum: r.comment_num ?? 0,
  rating: r.rating ?? null,
  soldNum: r.sold_num ?? null,
  winScore: r.win_score ?? 0,
  winTier: r.win_tier ?? "weak",
  opportunityScore: r.opportunity_score ?? 0,
  reason: r.reason ?? "",
  aiReason: r.ai_reason ?? null,
  status: (r.status ?? "new") as CandidateStatus,
  targetShop: r.target_shop ?? null,
  soldText: r.sold_text ?? null,
  rankText: r.rank_text ?? null,
  enrichedAt: r.enriched_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  validationScore: r.validation_score ?? null,
  verdict: r.verdict ?? null,
  isLocal: r.is_local ?? null,
  shipMode: r.ship_mode ?? null,
  trueToSize: r.true_to_size ?? null,
  ugcCount: r.ugc_count ?? null,
  ipRisk: r.ip_risk ?? null,
  validatedAt: r.validated_at ?? null,
  badges: (() => { try { return JSON.parse(r.validation_json || "{}").badges ?? []; } catch { return []; } })(),
  validation: (() => { try { return r.validation_json ? JSON.parse(r.validation_json) : null; } catch { return null; } })(),
});

/** Row research_product → Candidate-shaped (id="prod:<day>:<goodsId>", status=new). */
const productRowToCandidate = (r: any): Candidate => ({
  id: `prod:${r.day}:${r.goods_id}`,
  day: r.day,
  goodsId: r.goods_id,
  nicheKey: r.niche_key,
  nicheGroup: r.niche_group,
  name: r.name,
  image: r.image,
  url: r.url,
  storeCode: r.store_code ?? null,
  price: r.price ?? null,
  finalPrice: r.final_price ?? null,
  commentNum: r.comment_num ?? 0,
  rating: r.rating ?? null,
  soldNum: r.sold_num ?? null,
  winScore: r.win_score ?? 0,
  winTier: r.win_tier ?? "weak",
  opportunityScore: r.opportunity_score ?? 0,
  reason: "Từ research_product (ngách chưa lọt top candidate)",
  aiReason: null,
  status: "new",
  targetShop: null,
  soldText: r.sold_text ?? null,
  rankText: r.rank_text ?? null,
  enrichedAt: r.enriched_at ?? null,
  createdAt: r.captured_at ?? 0,
  updatedAt: r.captured_at ?? 0,
  validationScore: null, verdict: null, isLocal: null, shipMode: null,
  trueToSize: null, ugcCount: null, ipRisk: null, validatedAt: null, badges: [], validation: null,
});

export const researchStore = {
  init(): void {
    getDb();
  },

  /** Lưu (upsert) snapshot sp 1 ngày. Dedup theo (day, goods_id, niche_key). */
  saveProducts(day: string, items: ProductSnapshot[]): number {
    if (!items.length) return 0;
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO research_product (
        day, goods_id, niche_key, niche_group, name, image, url, store_code,
        price, retail_price, discount_pct, final_price, comment_num, rating,
        sold_num, win_score, win_tier, margin_score, opportunity_score, source, captured_at
      ) VALUES (
        @day, @goodsId, @nicheKey, @nicheGroup, @name, @image, @url, @storeCode,
        @price, @retailPrice, @discountPct, @finalPrice, @commentNum, @rating,
        @soldNum, @winScore, @winTier, @marginScore, @opportunityScore, @source, @capturedAt
      )
      ON CONFLICT(day, goods_id, niche_key) DO UPDATE SET
        opportunity_score=excluded.opportunity_score, win_score=excluded.win_score,
        win_tier=excluded.win_tier, margin_score=excluded.margin_score,
        sold_num=COALESCE(excluded.sold_num, research_product.sold_num),
        price=excluded.price, final_price=excluded.final_price,
        comment_num=excluded.comment_num, rating=excluded.rating, captured_at=excluded.captured_at
    `);
    const tx = db.transaction((rows: ProductSnapshot[]) => {
      for (const p of rows) {
        stmt.run({
          day,
          goodsId: p.goodsId,
          nicheKey: p.nicheKey,
          nicheGroup: p.nicheGroup,
          name: p.name,
          image: p.image,
          url: p.url,
          storeCode: p.storeCode ?? null,
          price: p.price,
          retailPrice: p.retailPrice,
          discountPct: p.discountPct,
          finalPrice: p.finalPrice,
          commentNum: p.commentNum,
          rating: p.rating,
          soldNum: p.soldNum ?? null,
          winScore: p.winScore,
          winTier: p.winTier,
          marginScore: p.marginScore,
          opportunityScore: p.opportunityScore,
          source: p.source,
          capturedAt: now,
        });
      }
    });
    tx(items);
    return items.length;
  },

  /** Lưu (upsert) rollup ngách 1 ngày. */
  saveNiches(day: string, items: NicheSnapshot[]): number {
    if (!items.length) return 0;
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO research_niche (
        day, niche_key, niche_group, query, supply_count, avg_top_win, hot_share,
        median_price, margin_band, heat_score, captured_at
      ) VALUES (
        @day, @nicheKey, @nicheGroup, @query, @supplyCount, @avgTopWin, @hotShare,
        @medianPrice, @marginBand, @heatScore, @capturedAt
      )
      ON CONFLICT(day, niche_key) DO UPDATE SET
        supply_count=excluded.supply_count, avg_top_win=excluded.avg_top_win,
        hot_share=excluded.hot_share, median_price=excluded.median_price,
        margin_band=excluded.margin_band, heat_score=excluded.heat_score,
        captured_at=excluded.captured_at
    `);
    const tx = db.transaction((rows: NicheSnapshot[]) => {
      for (const n of rows) {
        stmt.run({ day, capturedAt: now, ...n });
      }
    });
    tx(items);
    return items.length;
  },

  /** Ghi candidate cho 1 ngày (xoá candidate status=new cũ của ngày đó rồi insert lại). */
  saveCandidates(day: string, items: Omit<Candidate, "createdAt" | "updatedAt">[]): number {
    const db = getDb();
    const now = Date.now();
    const del = db.prepare(`DELETE FROM research_candidate WHERE day = ? AND status = 'new'`);
    const ins = db.prepare(`
      INSERT INTO research_candidate (
        id, day, goods_id, niche_key, niche_group, name, image, url, store_code,
        price, final_price, comment_num, rating, sold_num, win_score, win_tier,
        opportunity_score, reason, status, target_shop, created_at, updated_at
      ) VALUES (
        @id, @day, @goodsId, @nicheKey, @nicheGroup, @name, @image, @url, @storeCode,
        @price, @finalPrice, @commentNum, @rating, @soldNum, @winScore, @winTier,
        @opportunityScore, @reason, @status, @targetShop, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO NOTHING
    `);
    const tx = db.transaction((rows: Omit<Candidate, "createdAt" | "updatedAt">[]) => {
      del.run(day);
      for (const c of rows) {
        ins.run({ ...c, createdAt: now, updatedAt: now });
      }
    });
    tx(items);
    eventBus.emit("research", { type: "candidates", day, count: items.length });
    return items.length;
  },

  listCandidates(opts?: {
    day?: string;
    status?: CandidateStatus;
    niche?: string;
    limit?: number;
    offset?: number;
  }): { items: Candidate[]; total: number } {
    const db = getDb();
    const where: string[] = [];
    const params: any[] = [];
    if (opts?.day) { where.push("day = ?"); params.push(opts.day); }
    if (opts?.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts?.niche) { where.push("niche_key = ?"); params.push(opts.niche); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (db.prepare(`SELECT COUNT(*) c FROM research_candidate ${whereSql}`).get(...params) as { c: number }).c;
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = db.prepare(`
      SELECT * FROM research_candidate ${whereSql}
      ORDER BY opportunity_score DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { items: rows.map(candidateRowToObj), total };
  },

  findCandidate(id: string): Candidate | null {
    const row = getDb().prepare("SELECT * FROM research_candidate WHERE id = ?").get(id) as any;
    return row ? candidateRowToObj(row) : null;
  },

  /** research_product (mọi sp ngách, kể cả chưa lọt top candidate) → Candidate-shaped.
   *  id = "prod:<day>:<goodsId>" để phân biệt với candidate thật. */
  listProductsAsCandidates(day: string, niche: string, limit = 60): Candidate[] {
    const rows = getDb().prepare(`
      SELECT * FROM research_product WHERE day = ? AND niche_key = ?
      ORDER BY opportunity_score DESC LIMIT ?
    `).all(day, niche, limit) as any[];
    return rows.map(productRowToCandidate);
  },

  findProductCandidate(id: string): Candidate | null {
    const m = id.match(/^prod:([^:]+):(.+)$/);
    if (!m) return null;
    const r = getDb().prepare("SELECT * FROM research_product WHERE day = ? AND goods_id = ? LIMIT 1").get(m[1], m[2]) as any;
    return r ? productRowToCandidate(r) : null;
  },

  /** Đăng 1 sp (từ research_product) → tạo/đánh dấu candidate status=queued (để track + listedCount). */
  markProductQueued(cand: Candidate, shop: string): void {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO research_candidate (
        id, day, goods_id, niche_key, niche_group, name, image, url, store_code,
        price, final_price, comment_num, rating, sold_num, win_score, win_tier,
        opportunity_score, reason, status, target_shop, created_at, updated_at
      ) VALUES (
        @id,@day,@goodsId,@nicheKey,@nicheGroup,@name,@image,@url,@storeCode,
        @price,@finalPrice,@commentNum,@rating,@soldNum,@winScore,@winTier,
        @opportunityScore,@reason,'queued',@shop,@now,@now
      )
      ON CONFLICT(id) DO UPDATE SET status='queued', target_shop=@shop, updated_at=@now
    `).run({
      id: `${cand.day}:${cand.goodsId}`, day: cand.day, goodsId: cand.goodsId,
      nicheKey: cand.nicheKey, nicheGroup: cand.nicheGroup, name: cand.name, image: cand.image,
      url: cand.url, storeCode: cand.storeCode, price: cand.price, finalPrice: cand.finalPrice,
      commentNum: cand.commentNum, rating: cand.rating, soldNum: cand.soldNum, winScore: cand.winScore,
      winTier: cand.winTier, opportunityScore: cand.opportunityScore, reason: cand.reason, shop, now,
    });
  },

  /** Candidate chưa làm giàu sold (status=new, enriched_at NULL), điểm cao trước. */
  listUnenriched(day: string, limit = 20): Candidate[] {
    const rows = getDb().prepare(`
      SELECT * FROM research_candidate
      WHERE day = ? AND status = 'new' AND enriched_at IS NULL
      ORDER BY opportunity_score DESC LIMIT ?
    `).all(day, limit) as any[];
    return rows.map(candidateRowToObj);
  },

  /** Candidate chưa kiểm định (status=new, validated_at NULL), điểm cao trước. */
  listUnvalidated(day: string, limit = 20, niche?: string): Candidate[] {
    const w = ["day = ?", "status = 'new'", "validated_at IS NULL"];
    const p: any[] = [day];
    if (niche) { w.push("niche_key = ?"); p.push(niche); }
    const rows = getDb().prepare(`
      SELECT * FROM research_candidate WHERE ${w.join(" AND ")}
      ORDER BY opportunity_score DESC LIMIT ?
    `).all(...p, limit) as any[];
    return rows.map(candidateRowToObj);
  },

  /** PRE-FILTER + promote top sp 1 ngách (từ research_product) → candidate status=new,
   *  để Validate. Bỏ rác: rating<minRating, tên dính IP brand, giá gốc > maxCost. */
  promoteNicheProducts(day: string, niche: string, limit = 15): number {
    const cfg = researchConfig();
    const minRating = cfg.validation?.minRating ?? 4.0;
    const maxCost = cfg.dropScore?.cheap?.maxCost ?? 25;
    const ipBrands = (cfg.validation?.ipBrands ?? []).map((b) => b.toLowerCase());
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM research_product WHERE day = ? AND niche_key = ? ORDER BY opportunity_score DESC
    `).all(day, niche) as any[];
    const survivors = rows.filter((r) => {
      if (r.rating != null && r.rating < minRating) return false;
      if (r.price != null && r.price > maxCost) return false;
      const name = (r.name || "").toLowerCase();
      if (ipBrands.some((b) => b && name.includes(b))) return false;
      return true;
    }).slice(0, limit);
    const now = Date.now();
    const ins = db.prepare(`
      INSERT INTO research_candidate (
        id, day, goods_id, niche_key, niche_group, name, image, url, store_code,
        price, final_price, comment_num, rating, sold_num, win_score, win_tier,
        opportunity_score, reason, status, created_at, updated_at
      ) VALUES (
        @id,@day,@goodsId,@nicheKey,@nicheGroup,@name,@image,@url,@storeCode,
        @price,@finalPrice,@commentNum,@rating,@soldNum,@winScore,@winTier,
        @opportunityScore,@reason,'new',@now,@now
      ) ON CONFLICT(id) DO NOTHING
    `);
    const tx = db.transaction(() => {
      for (const r of survivors) ins.run({
        id: `${day}:${r.goods_id}`, day, goodsId: r.goods_id, nicheKey: r.niche_key,
        nicheGroup: r.niche_group, name: r.name, image: r.image, url: r.url, storeCode: r.store_code,
        price: r.price, finalPrice: r.final_price, commentNum: r.comment_num, rating: r.rating,
        soldNum: r.sold_num, winScore: r.win_score, winTier: r.win_tier,
        opportunityScore: r.opportunity_score, reason: "Soi ngách (pre-filtered)", now,
      });
    });
    tx();
    return survivors.length;
  },

  /** Ghi kết quả Deep Validation Gate vào candidate. */
  applyValidation(id: string, v: {
    validationScore: number; verdict: string; isLocal: boolean | null; shipMode: string;
    shipDays: number | null; trueToSize: number | null; ugcCount: number | null;
    ipRisk: boolean; validationJson: string;
  }): void {
    getDb().prepare(`
      UPDATE research_candidate SET
        validation_score=@validationScore, verdict=@verdict, is_local=@isLocal, ship_mode=@shipMode,
        ship_days=@shipDays, true_to_size=@trueToSize, ugc_count=@ugcCount, ip_risk=@ipRisk,
        validation_json=@validationJson, validated_at=@now, updated_at=@now
      WHERE id=@id
    `).run({
      id,
      validationScore: v.validationScore,
      verdict: v.verdict,
      isLocal: v.isLocal === null ? null : v.isLocal ? 1 : 0,
      shipMode: v.shipMode,
      shipDays: v.shipDays,
      trueToSize: v.trueToSize,
      ugcCount: v.ugcCount,
      ipRisk: v.ipRisk ? 1 : 0,
      validationJson: v.validationJson,
      now: Date.now(),
    });
  },

  /** Lấy 1 product snapshot (input để re-score) — bản ghi đầu của day+goodsId. */
  findProduct(day: string, goodsId: string): {
    price: number | null; retailPrice: number | null; discountPct: number | null;
    commentNum: number; rating: number | null; goodsSn: string;
  } | null {
    const r = getDb().prepare(`
      SELECT * FROM research_product WHERE day = ? AND goods_id = ? LIMIT 1
    `).get(day, goodsId) as any;
    if (!r) return null;
    return {
      price: r.price ?? null,
      retailPrice: r.retail_price ?? null,
      discountPct: r.discount_pct ?? null,
      commentNum: r.comment_num ?? 0,
      rating: r.rating ?? null,
      goodsSn: "",
    };
  },

  /** Ghi kết quả enrichment vào cả research_product (mọi ngách) lẫn candidate. */
  applyEnrichment(args: {
    day: string; goodsId: string; candidateId?: string;
    soldNum: number | null; soldText: string | null; rankText: string | null;
    winScore: number; winTier: string; opportunityScore: number;
  }): void {
    const db = getDb();
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE research_product SET
          sold_num=@soldNum, sold_text=@soldText, rank_text=@rankText,
          win_score=@winScore, win_tier=@winTier, opportunity_score=@opportunityScore,
          enriched_at=@now
        WHERE day=@day AND goods_id=@goodsId
      `).run({ ...args, now });
      if (args.candidateId) {
        db.prepare(`
          UPDATE research_candidate SET
            sold_num=@soldNum, sold_text=@soldText, rank_text=@rankText,
            win_score=@winScore, win_tier=@winTier, opportunity_score=@opportunityScore,
            enriched_at=@now, updated_at=@now
          WHERE id=@candidateId
        `).run({ ...args, now });
      }
    });
    tx();
  },

  updateCandidate(id: string, patch: { status?: CandidateStatus; targetShop?: string | null }): Candidate | null {
    const db = getDb();
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [Date.now()];
    if (patch.status) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.targetShop !== undefined) { sets.push("target_shop = ?"); params.push(patch.targetShop); }
    params.push(id);
    db.prepare(`UPDATE research_candidate SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const row = db.prepare("SELECT * FROM research_candidate WHERE id = ?").get(id) as any;
    return row ? candidateRowToObj(row) : null;
  },

  listNiches(day: string): NicheSnapshot[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM research_niche WHERE day = ? ORDER BY heat_score DESC
    `).all(day) as any[];
    return rows.map((r) => ({
      nicheKey: r.niche_key,
      nicheGroup: r.niche_group,
      query: r.query,
      supplyCount: r.supply_count,
      avgTopWin: r.avg_top_win,
      hotShare: r.hot_share,
      medianPrice: r.median_price ?? null,
      marginBand: r.margin_band,
      heatScore: r.heat_score,
    }));
  },

  /** Ghi ai_reason cho nhiều candidate trong 1 ngày (map goodsId → note). */
  applyAiReasons(day: string, notes: Record<string, string>): number {
    const entries = Object.entries(notes).filter(([, v]) => v && v.trim());
    if (!entries.length) return 0;
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE research_candidate SET ai_reason = ?, updated_at = ?
      WHERE day = ? AND goods_id = ?
    `);
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [goodsId, note] of entries) stmt.run(note.trim(), now, day, goodsId);
    });
    tx();
    return entries.length;
  },

  saveBriefing(day: string, briefing: string, suggestions: { key: string; query: string; why: string }[]): void {
    getDb().prepare(`
      INSERT INTO research_briefing (day, briefing, suggestions, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET briefing=excluded.briefing, suggestions=excluded.suggestions, created_at=excluded.created_at
    `).run(day, briefing, JSON.stringify(suggestions ?? []), Date.now());
  },

  getBriefing(day: string): { day: string; briefing: string; suggestions: { key: string; query: string; why: string }[]; createdAt: number } | null {
    const r = getDb().prepare("SELECT * FROM research_briefing WHERE day = ?").get(day) as any;
    if (!r) return null;
    let suggestions: any[] = [];
    try { suggestions = JSON.parse(r.suggestions || "[]"); } catch { /* ignore */ }
    return { day: r.day, briefing: r.briefing, suggestions, createdAt: r.created_at };
  },

  /** Các ngày đã có snapshot product, mới nhất trước. */
  listDays(limit = 30): string[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT day FROM research_product ORDER BY day DESC LIMIT ?
    `).all(limit) as { day: string }[];
    return rows.map((r) => r.day);
  },
};
