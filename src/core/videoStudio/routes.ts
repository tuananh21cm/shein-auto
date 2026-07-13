/**
 * Routes Video Studio, mount vào admin server (đã qua requireAuth vì
 * path /admin/api/*). Tách file riêng để adminServer.ts không phình thêm.
 */
import type express from "express";
import fs from "fs-extra";
import path from "path";
import { VideoDb } from "../../state/videoDb";
import { TiktokDb } from "../../services/tiktok/db";
import { suggestProducts } from "./suggestProducts";
import { videoQueue, CreateVideoItem } from "./videoQueue";
import { EditDb } from "../../services/tiktok/editDb";
import { publishVideo } from "./publishVideo";
import { buildCaption } from "./buildCaption";
import {
  publishStatus, runPublishTick, isAutoPublishOn, setAutoPublish, DEFAULT_SCHEDULER,
} from "./publishScheduler";

/** Đăng 1 video ngay (nút "Đăng ngay" trên UI). Chạy nền, log ra SSE. */
async function publishOne(id: number, dryRun: boolean): Promise<void> {
  const vdb = new VideoDb();
  const edb = new EditDb();
  try {
    const row = vdb.get(id);
    if (!row) throw new Error(`Không có video #${id}`);
    if (!row.file) throw new Error(`Video #${id} chưa render xong`);
    const profile = edb.getProfile(row.shop);
    if (!profile) throw new Error(`Shop "${row.shop}" chưa map Kiki profile (tab TikTok Edit)`);

    const script = row.script_json ? JSON.parse(row.script_json) : null;
    const r = await publishVideo({
      profileId: profile,
      videoId: id,
      videoFile: row.file,
      caption: buildCaption({ title: row.title, seed: row.seed, script }),
      productId: row.product_id,
      dryRun,
      onLog: (m) => console.log(m),
    });
    if (r.posted) vdb.markPosted(id);
  } catch (e: any) {
    vdb.setPostError(id, String(e?.message ?? e));
    console.error(`❌ [Publish #${id}] ${e?.message ?? e}`);
  } finally {
    vdb.close();
    edb.close();
  }
}

export function registerVideoRoutes(app: express.Express): void {
  // Shops có data view để đề xuất
  app.get("/admin/api/videos/shops", (_req, res) => {
    const db = new TiktokDb();
    try { res.json({ shops: db.listTrackedShops() }); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
    finally { db.close(); }
  });

  // Đề xuất sản phẩm tiềm năng của 1 shop
  app.get("/admin/api/videos/suggest", async (req, res) => {
    try {
      const shop = String(req.query.shop ?? "");
      if (!shop) return res.status(400).json({ error: "Thiếu ?shop=" });
      const limit = Math.min(200, parseInt(String(req.query.limit ?? "50")) || 50);
      res.json(await suggestProducts(shop, { limit }));
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // Enqueue tạo video
  app.post("/admin/api/videos/create", (req, res) => {
    try {
      const { shop, items } = req.body as { shop: string; items: CreateVideoItem[] };
      if (!shop || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: "Cần {shop, items:[{productId,listingId,title}]}" });
      }
      const ids = videoQueue.enqueue(shop, items);
      res.json({ queued: ids.length, ids });
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // List videos
  app.get("/admin/api/videos", (req, res) => {
    const db = new VideoDb();
    try {
      res.json({
        videos: db.list({
          shop: req.query.shop ? String(req.query.shop) : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
        }),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
    finally { db.close(); }
  });

  // Stream/download file mp4
  app.get("/admin/api/videos/file/:id", (req, res) => {
    const db = new VideoDb();
    try {
      const row = db.get(parseInt(req.params.id));
      if (!row?.file || !fs.pathExistsSync(row.file)) return res.status(404).json({ error: "Chưa có file" });
      res.sendFile(path.resolve(row.file));
    } finally { db.close(); }
  });

  app.post("/admin/api/videos/:id/retry", (req, res) => {
    try { videoQueue.retry(parseInt(req.params.id)); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  app.post("/admin/api/videos/:id/posted", (req, res) => {
    const db = new VideoDb();
    try { db.markPosted(parseInt(req.params.id)); res.json({ ok: true }); }
    finally { db.close(); }
  });

  // Xóa row + file mp4 (giữ assets cache ảnh của sản phẩm)
  app.delete("/admin/api/videos/:id", async (req, res) => {
    const db = new VideoDb();
    try {
      const row = db.get(parseInt(req.params.id));
      if (row?.file) await fs.remove(row.file).catch(() => {});
      db.remove(parseInt(req.params.id));
      res.json({ ok: true });
    } finally { db.close(); }
  });

  /* ── Auto-publish ────────────────────────────────────────── */

  // Trạng thái quota từng shop + cờ auto
  app.get("/admin/api/videos/publish/status", (_req, res) => {
    try {
      res.json({ auto: isAutoPublishOn(), cfg: DEFAULT_SCHEDULER, shops: publishStatus() });
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // Bật/tắt cron auto-publish
  app.post("/admin/api/videos/publish/auto", (req, res) => {
    setAutoPublish(!!req.body?.on);
    res.json({ auto: isAutoPublishOn() });
  });

  // Chạy 1 tick ngay (không đợi cron). ?dryRun=1 = không bấm Post.
  app.post("/admin/api/videos/publish/tick", (req, res) => {
    const dryRun = !!req.body?.dryRun;
    res.json({ started: true, dryRun }); // chạy nền, tiến độ xem qua log SSE
    runPublishTick({ dryRun, onLog: (m) => console.log(m) })
      .catch((e: any) => console.error(`❌ [PublishTick] ${e?.message ?? e}`));
  });

  // Đăng ngay 1 video (bỏ qua quota/giãn cách — user chủ động)
  app.post("/admin/api/videos/:id/publish", (req, res) => {
    const id = parseInt(req.params.id);
    const dryRun = !!req.body?.dryRun;
    res.json({ started: true, id, dryRun });
    publishOne(id, dryRun).catch(() => {});
  });
}
