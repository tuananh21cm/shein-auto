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
}
