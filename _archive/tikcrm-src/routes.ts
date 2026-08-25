/**
 * Routes TikCRM: nhận mirror shop_health từ extension TikCheck + UI xem data.
 * Mount vào admin server. Ingest (/webhook/tikcheck/*) được whitelist khỏi
 * requireAuth trong adminServer.ts (extension gửi không kèm session).
 */
import type express from "express";
import path from "path";
import { saveShopHealth, listShops, getShopHistory } from "./store";
import { getLinkedShops, isLinked } from "./kbtLinked";
import { saveListings, getListings } from "./listingsStore";
import { saveRaw, getRaw } from "./rawStore";
import { recordDaily, getDailySeries, getDaySnapshot, dayKey, getOrCreateReportToken, resolveReportToken, getOverview, getLatestKindSnapshot, listShopsOverview } from "./dailyStore";
import { refreshFourSeller } from "./fourseller4crm";
import { recommendShop, recommendAll } from "./recommend";
import { enqueueVideosFromRecs } from "./videoFromRecs";
import { getListingMovement } from "./listingMovement";
import { computeDeleteCandidates } from "./deleteCandidates";
import { parseReturns } from "./returnsParser";
import { requestVideo, refreshVideoState, getVideoFile } from "./videoOnDemand";
import { refreshSheinSuggestForShop, refreshSheinSuggestAll, setSheinOverride, getShopNiche } from "./sheinSuggest";

/** Gom dữ liệu báo cáo 1 shop (dùng cho trang public + admin). */
function buildReport(code: string) {
  const series = getDailySeries(code, 30);
  const latest: any = series[0] ?? {};
  const os = getRaw("orderstatus", code);
  const promoExt = getRaw("promotion", code);
  const listings = getListings(code);
  const fourseller = getLatestKindSnapshot(code, "fourseller")?.data ?? null;   // mới nhất có sẵn
  const recSnap = getLatestKindSnapshot(code, "recommendations");
  // Gắn ảnh + product_id vào đề xuất AI (match tên SP → listing)
  const recData: any = recSnap?.data ? { ...recSnap.data } : null;
  if (recData) {
    const norm = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const lls = listings.listings ?? [];
    const enrich = (arr: any[]) => (arr || []).map((x: any) => {
      const nm = norm(x.san_pham);
      const l = lls.find((z: any) => { const zn = norm(z.product_name); return zn === nm || (nm.length > 6 && zn.startsWith(nm)); });
      return { ...x, image: (l as any)?.image || "", product_id: (l as any)?.product_id || "", pv_28d: (l as any)?.pv_28d, orders_28d: (l as any)?.orders_28d };
    });
    recData.xoa = enrich(recData.xoa); recData.flash = enrich(recData.flash); recData.video = enrich(recData.video);
  }
  // Gắn ngày list (từ 4Seller) + tuổi listing vào top listing
  const listDates: Record<string, string> = (fourseller && fourseller.listing_dates) || {};
  const nowMs = Date.now();
  const listings_top = (listings.listings ?? []).slice(0, 15).map((x: any) => {
    const ld = listDates[String(x.product_id)];
    const dm = ld ? Date.parse(String(ld).replace(" ", "T")) : NaN;
    const age = Number.isFinite(dm) ? Math.floor((nowMs - dm) / 86_400_000) : null;
    return { ...x, list_date: ld || null, age_days: age };
  });

  // Ma trận chuyển đổi (CVR = đơn/view) — chia 4 ô: winner / phí traffic / viên ngọc ẩn / chết
  const _lls: any[] = (listings.listings ?? []) as any[];
  const _pvs = _lls.map((l) => Number(l.pv_28d) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const viewMed = _pvs.length ? _pvs[Math.floor(_pvs.length / 2)] : 0;
  const quad: Record<string, any[]> = { winner: [], waste: [], gem: [], dead: [] };
  for (const l of _lls) {
    const pv = Number(l.pv_28d) || 0, orders = Number(l.orders_28d) || 0;
    if (pv <= 0 && orders <= 0) continue;
    const it = { product_id: l.product_id, name: l.product_name, image: l.image, pv, orders, cvr: pv > 0 ? Math.round((orders / pv) * 10000) / 100 : 0, gmv: l.gmv_28d };
    const hiView = pv >= viewMed, conv = orders > 0;
    (hiView && conv ? quad.winner : hiView ? quad.waste : conv ? quad.gem : quad.dead).push(it);
  }
  quad.winner.sort((a, b) => b.orders - a.orders);
  quad.waste.sort((a, b) => b.pv - a.pv);
  quad.gem.sort((a, b) => b.cvr - a.cvr);
  quad.dead.sort((a, b) => a.pv - b.pv);
  const conversion = {
    view_median: viewMed,
    counts: { winner: quad.winner.length, waste: quad.waste.length, gem: quad.gem.length, dead: quad.dead.length },
    quadrants: { winner: quad.winner.slice(0, 6), waste: quad.waste.slice(0, 6), gem: quad.gem.slice(0, 6), dead: quad.dead.slice(0, 6) },
  };

  return {
    conversion,
    shop: {
      code, name: latest.shop_name ?? code, region: latest.region ?? "",
      shop_status: latest.shop_status ?? null, has_4seller: latest.has_4seller ?? 0,
    },
    latest,
    series: series.slice().reverse(), // cũ → mới cho biểu đồ
    orderstatus: os?.columns ?? [],
    promotion: { ext: promoExt?.summary ?? null, fourseller },
    recommendations: recData,
    recommendations_day: recSnap?.day ?? null,
    listings_top,
    movement: getListingMovement(code),
    shein_suggest: getLatestKindSnapshot(code, "sheinsuggest")?.data ?? null,
    delete_candidates: computeDeleteCandidates(code),
    returns: getLatestKindSnapshot(code, "returns")?.data ?? null,
  };
}

export function registerTikcrmRoutes(app: express.Express): void {
  // CORS cho mọi webhook TikCheck → extension đọc được response (ok) để chỉ throttle khi push thành công
  app.use("/webhook/tikcheck", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── Báo cáo shop PUBLIC qua token (không cần login) ──
  app.get("/r/:token", (req, res) => {
    const code = resolveReportToken(req.params.token);
    if (!code) return res.status(404).send("Link báo cáo không hợp lệ hoặc đã hết hạn.");
    res.sendFile(path.join(__dirname, "..", "..", "public", "report.html"));
  });
  app.get("/r/:token/data", (req, res) => {
    try {
      const code = resolveReportToken(req.params.token);
      if (!code) return res.status(404).json({ error: "token không hợp lệ" });
      res.json(buildReport(code));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi báo cáo" });
    }
  });
  // ── Làm video theo yêu cầu (nút trên report) — scope theo token ──
  app.post("/r/:token/video/request", async (req, res) => {
    try {
      const code = resolveReportToken(req.params.token);
      if (!code) return res.status(404).json({ error: "token không hợp lệ" });
      const productId = String(req.body?.product_id || "").trim();
      if (!productId) return res.status(400).json({ error: "thiếu product_id" });
      const r = await requestVideo(code, productId);
      if ("error" in r) return res.status(400).json(r);
      res.json(r);
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi tạo video" }); }
  });
  app.get("/r/:token/video/state", async (req, res) => {
    try {
      const code = resolveReportToken(req.params.token);
      if (!code) return res.status(404).json({ error: "token không hợp lệ" });
      res.json({ jobs: await refreshVideoState(code) });
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi state" }); }
  });
  app.get("/r/:token/video/download/:productId", async (req, res) => {
    try {
      const code = resolveReportToken(req.params.token);
      if (!code) return res.status(404).send("token không hợp lệ");
      const r = await getVideoFile(code, req.params.productId);
      if ("error" in r) return res.status(400).send(r.error);
      res.download(r.file, `video_${req.params.productId}.mp4`);
    } catch (err: any) { res.status(500).send(err?.message ?? "lỗi tải video"); }
  });

  // Proxy ảnh listing (TikTok CDN hay chặn hotlink cross-origin) → server tải hộ, stream same-origin
  app.get("/webhook/tikcheck/imgproxy", async (req, res) => {
    let u = String(req.query.u || "");
    if (u.startsWith("//")) u = "https:" + u;              // URL protocol-relative (SHEIN/Apify hay trả //img…)
    if (u.startsWith("http://")) u = "https://" + u.slice(7);
    if (!/^https:\/\/[a-z0-9.-]*(ttcdn-us\.com|tiktokcdn|byteimg|ibyteimg|isappcloud|ltwebstatic\.com|shein\.com|sheinsz\.com)/i.test(u)) return res.status(400).end();
    try {
      const r = await fetch(u);
      if (!r.ok) return res.status(502).end();
      res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.status(502).end(); }
  });

  // Discovery: sniffer extension gửi các BFF request (return/aftersale/…) để tìm endpoint
  app.post("/webhook/tikcheck/discovery", (req, res) => {
    try {
      const b = req.body || {};
      const dir = path.join(__dirname, "..", "..", "..", "data", "tikcrm", "discovery");
      require("fs-extra").ensureDirSync(dir);
      const safe = String(b.url || "unknown").split("?")[0].replace(/^https?:\/\//, "").replace(/[^\w.-]/g, "_").slice(0, 120);
      require("fs-extra").writeJsonSync(path.join(dir, safe + ".json"), { received_at: new Date().toISOString(), ...b }, { spaces: 1 });
      console.log(`🔎 [Discovery] ${b.method || "?"} ${String(b.url || "").split("?")[0]} → status ${b.status}`);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi" }); }
  });

  // Extension lấy link báo cáo (public, whitelist — nội bộ) theo shop_code
  app.get("/webhook/tikcheck/report-link", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*"); // extension đọc response cross-origin
    try {
      const code = String(req.query.code || "").trim();
      if (!code) return res.status(400).json({ error: "thiếu code" });
      const token = getOrCreateReportToken(code);
      res.json({ token, path: `/r/${token}`, url: `https://tikcrm.tooltik.app/r/${token}` });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi" });
    }
  });

  // Admin lấy link báo cáo của 1 shop (tạo token nếu chưa có)
  app.get("/admin/api/tikcrm/report-link/:code", (req, res) => {
    try {
      const token = getOrCreateReportToken(req.params.code);
      res.json({ token, path: `/r/${token}` });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi tạo link" });
    }
  });

  // ── Gợi ý SP win SHEIN theo ngách ──
  // Refresh 1 shop (?code=) hoặc tất cả (không có code)
  app.post("/admin/api/tikcrm/shein/refresh", async (req, res) => {
    try {
      const code = String(req.query.code || "").trim();
      if (code) { const r = await refreshSheinSuggestForShop(code, { apify: req.query.apify === "1", onLog: (m) => console.log("[SHEIN]", m) }); return res.json({ ok: !!r, result: r }); }
      const r = await refreshSheinSuggestAll((m) => console.log("[SHEIN]", m));
      res.json(r);
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi" }); }
  });
  // Xem ngách auto-detect + cho map thủ công (override)
  app.get("/admin/api/tikcrm/shein/niche/:code", (req, res) => {
    res.json({ code: req.params.code, niche: getShopNiche(req.params.code) });
  });
  app.post("/admin/api/tikcrm/shein/override", async (req, res) => {
    try {
      const { code, cat_id, cat_name, niche } = req.body || {};
      if (!code || !cat_id) return res.status(400).json({ error: "thiếu code/cat_id" });
      setSheinOverride(String(code), String(cat_id), String(cat_name || cat_id), niche);
      const r = await refreshSheinSuggestForShop(String(code), { onLog: (m) => console.log("[SHEIN]", m) });
      res.json({ ok: !!r, result: r });
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi" }); }
  });

  // ── Ingest: extension POST bản mirror về đây (không auth) ──
  app.post("/webhook/tikcheck/shop-health", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || !body.payload) {
        return res.status(400).json({ error: "thiếu payload" });
      }
      const code = saveShopHealth(body);
      recordDaily("health", body);
      console.log(`📥 [TikCRM] shop_health ← ${code} (${body.payload?.shop_name ?? ""})`);
      res.json({ ok: true, shop: code });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi lưu" });
    }
  });

  // ── Ingest listings (extension mirror, không auth) ──
  app.post("/webhook/tikcheck/shop-listings", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || !body.payload) {
        return res.status(400).json({ error: "thiếu payload" });
      }
      const code = saveListings(body);
      recordDaily("listings", body);
      const cnt = Array.isArray(body.payload?.listings) ? body.payload.listings.length : 0;
      console.log(`📥 [TikCRM] shop_listings ← ${code} (${cnt} SP)`);
      // Tự sinh AI recs ngay sau khi cào (nếu hôm nay chưa có) → khỏi chờ cron 7h, shop mới cào có recs liền
      try {
        if (cnt > 0 && getLatestKindSnapshot(code, "recommendations")?.day !== dayKey()) {
          recommendShop(code)
            .then(() => console.log(`🤖 [TikCRM] auto-rec ← ${code}`))
            .catch((e: any) => console.warn(`[auto-rec] ${code}: ${e?.message ?? e}`));
        }
      } catch { /* auto-rec không chặn ingest */ }
      res.json({ ok: true, shop: code, count: cnt });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi lưu listings" });
    }
  });

  // Biến động view per-listing (2 ngày snapshot gần nhất)
  app.get("/admin/api/tikcrm/movement/:code", (req, res) => {
    try { res.json(getListingMovement(req.params.code)); }
    catch (err: any) { res.status(500).json({ ok: false, error: err?.message ?? "lỗi movement" }); }
  });

  app.get("/admin/api/tikcrm/listings/:code", (req, res) => {
    try {
      res.json(getListings(req.params.code));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi đọc listings" });
    }
  });

  // ── Generic raw ingest (orders / finance / loại mới) ──
  // Returns & Refunds: extension gửi raw 2 response BFF reverse → server parse
  app.post("/webhook/tikcheck/raw/returns", (req, res) => {
    try {
      const p = req.body?.payload || {};
      const code = p.shop_code || p.shop_id;
      if (!code) return res.status(400).json({ error: "thiếu shop_code" });
      const parsed = parseReturns(p.dashboard, p.orders);
      recordDaily("returns", { payload: { shop_code: code, region: p.region, shop_name: p.shop_name, ...parsed } });
      console.log(`📥 [TikCRM] returns ← ${code}: ${parsed.orders.length} đơn · awaiting ${parsed.awaiting_action}`);
      res.json({ ok: true, orders: parsed.orders.length, tiles: parsed.tiles.length });
    } catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi returns" }); }
  });

  app.post("/webhook/tikcheck/raw/:kind", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || !body.payload) {
        return res.status(400).json({ error: "thiếu payload" });
      }
      const { code, count } = saveRaw(req.params.kind, body);
      recordDaily(req.params.kind, body);
      console.log(`📥 [TikCRM] raw/${req.params.kind} ← ${code} (${count})`);
      res.json({ ok: true, kind: req.params.kind, shop: code, count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi lưu raw" });
    }
  });

  // Phase 2: kéo 4Seller (promotion Flash/Discount) cho mọi shop khớp — chạy tay/test
  app.post("/admin/api/tikcrm/fourseller/refresh", async (_req, res) => {
    try {
      const r = await refreshFourSeller((m) => console.log("[4crm]", m));
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi refresh 4Seller" });
    }
  });

  // Phase 5: thống kê tổng cho dashboard
  app.get("/admin/api/tikcrm/overview", (_req, res) => {
    try { res.json(getOverview()); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi overview" }); }
  });

  // Phase 3: AI đề xuất — 1 shop / toàn bộ
  app.post("/admin/api/tikcrm/recommend/:code", async (req, res) => {
    try {
      const rec = await recommendShop(req.params.code);
      if (!rec) return res.status(422).json({ error: "shop thiếu data (chưa có listing) hoặc AI lỗi" });
      res.json({ ok: true, rec });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi AI" });
    }
  });
  // Phase 6: gen video từ đề xuất AI (render, không publish)
  app.post("/admin/api/tikcrm/gen-video/:code", async (req, res) => {
    try {
      const r = await enqueueVideosFromRecs(req.params.code, (m) => console.log("[genvid]", m));
      res.status(r.ok ? 200 : 422).json(r);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi gen video" });
    }
  });

  app.post("/admin/api/tikcrm/recommend-all", async (_req, res) => {
    try {
      const r = await recommendAll((m) => console.log("[rec]", m));
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi AI batch" });
    }
  });

  // Phase 1: chuỗi snapshot theo ngày của 1 shop (index) + optional snapshot 1 ngày
  app.get("/admin/api/tikcrm/daily/:code", (req, res) => {
    try {
      const series = getDailySeries(req.params.code, Number(req.query.limit) || 60);
      const day = (req.query.day as string) || "";
      res.json({ series, snapshot: day ? getDaySnapshot(req.params.code, day) : undefined });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi đọc daily" });
    }
  });

  app.get("/admin/api/tikcrm/raw/:kind/:code", (req, res) => {
    try {
      res.json(getRaw(req.params.kind, req.params.code) ?? { empty: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi đọc raw" });
    }
  });

  // ── UI page (sau requireAuth: cần đăng nhập admin để xem) ──
  const authed = (req: any) => req.session && req.session.user;
  app.get("/admin/tikcrm", (req, res) => {
    if (authed(req)) return res.sendFile(path.join(__dirname, "..", "..", "public", "tikcrm.html"));
    return res.redirect("/admin/login");
  });
  // Dashboard fleet mới (tổng quan + bảng shop có data)
  app.get("/admin/tikcrm/fleet", (req, res) => {
    if (authed(req)) return res.sendFile(path.join(__dirname, "..", "..", "public", "fleet.html"));
    return res.redirect("/admin/login");
  });
  // Mở report 1 shop từ dashboard (tạo token nếu chưa có → redirect)
  app.get("/admin/tikcrm/r/:code", (req, res) => {
    if (!authed(req)) return res.redirect("/admin/login");
    try { return res.redirect("/r/" + getOrCreateReportToken(req.params.code)); }
    catch { return res.status(500).send("lỗi token"); }
  });
  // Data cho dashboard fleet: tổng quan + list shop có data
  app.get("/admin/api/tikcrm/fleet", (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: "chưa đăng nhập" });
    try { res.json({ overview: getOverview(), shops: listShopsOverview() }); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? "lỗi fleet" }); }
  });

  // ── API cho UI ──
  app.get("/admin/api/tikcrm/shops", async (_req, res) => {
    try {
      const linked = await getLinkedShops();
      const shops = listShops().map((r) => {
        const p = r.payload || {};
        return { received_at: r.received_at, first_seen: r.first_seen, ...p, kbt_linked: isLinked(linked, p.shop_id, p.shop_code) };
      });
      res.json({ shops, kbt: { configured: linked.configured, ok: linked.ok, count: linked.count, error: linked.error } });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi đọc" });
    }
  });

  // Trạng thái nguồn apps.kbt (debug / hiển thị trên UI)
  app.get("/admin/api/tikcrm/kbt-status", async (req, res) => {
    try {
      const r = await getLinkedShops(req.query.force === "1");
      res.json({ configured: r.configured, ok: r.ok, count: r.count, error: r.error, fetchedAt: r.fetchedAt });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi" });
    }
  });

  app.get("/admin/api/tikcrm/shop/:code", (req, res) => {
    try {
      const history = getShopHistory(req.params.code);
      res.json({ code: req.params.code, history });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "lỗi đọc" });
    }
  });
}
