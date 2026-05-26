import express from "express";
import session from "express-session";
import path from "path";
import fs from "fs-extra";
import { chromium } from "playwright-core";
import {
  loadAdminConfig,
  saveAdminConfig,
  AdminConfig,
  AdminUser,
  verifyPassword,
  isHashed,
  hashPassword,
} from "./adminConfig";
import { config } from "./config";
import { workerState } from "./state/workerState";
import { refreshQueueSnapshot } from "./state/queueState";
import { historyStore } from "./state/historyStore";
import { scanListings, scanShopsSummary, resolveListingPath, ListingStatus } from "./state/listingScan";
import { eventBus } from "./state/eventBus";
import { workerConfig, reloadAppConfig } from "./config/appConfig";
import { configCookie } from "./utils/configCookie";

const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "shein-auto-secret";

type SessionUser = { username: string; role: "admin" | "editor" | "viewer" };

const sanitizeUserForUi = (user: AdminUser) => ({
  username: user.username,
  password: "",
  role: user.role,
  profiles: user.profiles,
  downloadDir: user.downloadDir ?? "",
  baseSheinAutoDir: user.baseSheinAutoDir ?? "",
});

const sanitizeConfigForUi = (cfg: AdminConfig) => ({
  users: cfg.users.map(sanitizeUserForUi),
  settings: cfg.settings,
});

export const startAdminServer = async () => {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(
    session({
      secret: adminSessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 8 },
    })
  );

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.session && (req.session as any).user) return next();
    if (
      req.path.startsWith("/admin/api/auth") ||
      req.path === "/admin/login" ||
      req.path === "/admin/logout"
    ) {
      return next();
    }
    // API call → trả JSON 401 (cho client xử lý), không redirect HTML
    if (req.path.startsWith("/admin/api/")) {
      return res.status(401).json({ error: "Chưa đăng nhập" });
    }
    // HTML navigation → redirect login page
    return res.redirect("/admin/login");
  };
  app.use(requireAuth);

  // ── Static HTML routes ─────────────────────────────────────
  app.get("/admin/login", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
  });

  app.get("/admin/logout", (req, res) => {
    req.session?.destroy(() => res.redirect("/admin/login"));
  });

  app.get("/admin", (req, res) => {
    if (req.session && (req.session as any).user) {
      return res.sendFile(path.join(__dirname, "public", "admin.html"));
    }
    return res.redirect("/admin/login");
  });

  // ── Auth ──────────────────────────────────────────────────
  app.post("/admin/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body as { username: string; password: string };
      if (!username || !password) {
        return res.status(400).json({ error: "Username và password là bắt buộc" });
      }
      const cfg = await loadAdminConfig();
      const user = cfg.users.find((u) => u.username === username);
      if (!user || !verifyPassword(password, user.password)) {
        return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });
      }
      // Migration: nếu vẫn là plaintext, re-hash ngay
      if (!isHashed(user.password)) {
        user.password = hashPassword(password);
        await saveAdminConfig(cfg);
      }
      (req.session as any).user = { username: user.username, role: user.role };
      return res.json({ username: user.username, role: user.role });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || "Lỗi đăng nhập" });
    }
  });

  app.get("/admin/api/auth/me", (req, res) => {
    if (req.session && (req.session as any).user) {
      return res.json((req.session as any).user);
    }
    return res.status(401).json({ error: "Chưa đăng nhập" });
  });

  // ── User config (giữ logic cũ) ────────────────────────────
  app.get("/admin/api/config", async (req, res) => {
    try {
      const cfg = await loadAdminConfig();
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "admin") return res.json(sanitizeConfigForUi(cfg));
      const currentUser = cfg.users.find((u) => u.username === sessionUser.username);
      if (!currentUser) return res.status(404).json({ error: "Người dùng không tồn tại" });
      return res.json({ users: [sanitizeUserForUi(currentUser)], settings: cfg.settings });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Không thể đọc cấu hình" });
    }
  });

  app.post("/admin/api/config", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const cfg = await loadAdminConfig();

      if (sessionUser.role === "admin") {
        const payload = req.body as AdminConfig;
        // Validate trùng username
        const seen = new Set<string>();
        for (const u of payload.users) {
          if (!u.username) return res.status(400).json({ error: "Username không được rỗng" });
          if (seen.has(u.username)) {
            return res.status(400).json({ error: `Username trùng: ${u.username}` });
          }
          seen.add(u.username);
        }

        const merged = payload.users.map((u) => {
          const existing = cfg.users.find((it) => it.username === u.username);
          return {
            username: u.username,
            password: u.password ? hashPassword(u.password) : existing?.password ?? "",
            role: u.role,
            profiles: Array.isArray(u.profiles) ? u.profiles : [],
            downloadDir: typeof u.downloadDir === "string" ? u.downloadDir : existing?.downloadDir ?? "",
            baseSheinAutoDir:
              typeof u.baseSheinAutoDir === "string" ? u.baseSheinAutoDir : existing?.baseSheinAutoDir ?? "",
          };
        });
        const newCfg: AdminConfig = {
          users: merged,
          settings: payload.settings ?? cfg.settings,
        };
        const saved = await saveAdminConfig(newCfg);
        return res.json(sanitizeConfigForUi(saved));
      }

      // Non-admin chỉ update chính mình
      const payload = req.body as AdminConfig;
      const updatedUser = Array.isArray(payload.users) ? payload.users[0] : null;
      if (!updatedUser || updatedUser.username !== sessionUser.username) {
        return res.status(400).json({ error: "Không thể cập nhật người dùng" });
      }
      const existingUser = cfg.users.find((u) => u.username === sessionUser.username);
      if (!existingUser) return res.status(404).json({ error: "Người dùng không tồn tại" });

      if (updatedUser.password) existingUser.password = hashPassword(updatedUser.password);
      existingUser.profiles = Array.isArray(updatedUser.profiles)
        ? updatedUser.profiles
        : existingUser.profiles;
      if (typeof updatedUser.downloadDir === "string") {
        existingUser.downloadDir = updatedUser.downloadDir;
      }
      if (typeof updatedUser.baseSheinAutoDir === "string") {
        existingUser.baseSheinAutoDir = updatedUser.baseSheinAutoDir;
      }

      const saved = await saveAdminConfig(cfg);
      return res.json({
        users: [sanitizeUserForUi(saved.users.find((u) => u.username === sessionUser.username)!)],
        settings: saved.settings,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Không thể lưu cấu hình" });
    }
  });

  // ── Dashboard ─────────────────────────────────────────────
  app.get("/admin/api/dashboard", async (_req, res) => {
    try {
      const queue = await refreshQueueSnapshot();
      res.json({
        worker: workerState.get(),
        queue,
        config: {
          concurrency: workerConfig().concurrency,
          fileRouterCron: config.cronFileRouter,
          queueManagerCron: config.cronQueueManager,
          telegramEnabled: !!(config.telegramBotToken && config.telegramChatId),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy dashboard" });
    }
  });

  // ── SSE: live log + events ───────────────────────────────
  app.get("/admin/api/events/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("hello", { ts: Date.now() });

    const onLog = (entry: any) => send("log", entry);
    const onWorker = (snap: any) => send("worker", snap);
    const onQueue = (snap: any) => send("queue", snap);
    const onHistory = (entry: any) => send("history", entry);
    const keepalive = setInterval(() => res.write(":\n\n"), 15000);

    eventBus.on("log", onLog);
    eventBus.on("worker:state", onWorker);
    eventBus.on("queue", onQueue);
    eventBus.on("history", onHistory);

    req.on("close", () => {
      clearInterval(keepalive);
      eventBus.off("log", onLog);
      eventBus.off("worker:state", onWorker);
      eventBus.off("queue", onQueue);
      eventBus.off("history", onHistory);
    });
  });

  // Helper: non-admin chỉ thấy shops/listings của chính mình. Admin thấy tất cả.
  const ownerScope = (req: express.Request): string | undefined => {
    const sessionUser = (req.session as any).user as SessionUser;
    return sessionUser.role === "admin" ? undefined : sessionUser.username;
  };

  // ── Listings (product cards view) ────────────────────────
  app.get("/admin/api/listings/shops", async (req, res) => {
    try {
      const shops = await scanShopsSummary({ username: ownerScope(req) });
      res.json({ shops });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi scan shops" });
    }
  });

  app.get("/admin/api/listings", async (req, res) => {
    try {
      const status = req.query.status as ListingStatus | undefined;
      const folder = (req.query.folder as string) || undefined;
      const items = await scanListings({ status, folder, username: ownerScope(req) });
      res.json({ items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi scan listings" });
    }
  });

  app.get("/admin/api/listings/json", async (req, res) => {
    try {
      const id = req.query.id as string;
      if (!id) return res.status(400).json({ error: "Thiếu id" });
      const resolved = await resolveListingPath(id);
      if (!resolved) return res.status(400).json({ error: "Id không hợp lệ" });

      // Non-admin chỉ xem được của mình
      const scope = ownerScope(req);
      if (scope && !resolved.owner.split(",").includes(scope)) {
        return res.status(403).json({ error: "Không có quyền xem listing này" });
      }

      if (!(await fs.pathExists(resolved.full))) {
        return res.status(404).json({ error: "File không tồn tại" });
      }
      const raw = await fs.readFile(resolved.full, "utf-8");
      res.json({ id, content: JSON.parse(raw) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc JSON" });
    }
  });

  app.post("/admin/api/listings/retry", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể retry" });

      const id = (req.body?.id as string) || "";
      const resolved = await resolveListingPath(id);
      if (!resolved) return res.status(400).json({ error: "Id không hợp lệ" });
      if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
        return res.status(403).json({ error: "Không có quyền retry listing này" });
      }
      if (resolved.status !== "fail") {
        return res.status(400).json({ error: "Chỉ retry được file Fail" });
      }
      if (!(await fs.pathExists(resolved.full))) {
        return res.status(404).json({ error: "File không còn ở Fail" });
      }
      const target = path.join(resolved.baseDir, resolved.folder, resolved.file);
      await fs.move(resolved.full, target, { overwrite: true });
      const errLog = `${resolved.full}.error.log`;
      if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
      res.json({ ok: true, newStatus: "pending", folder: resolved.folder });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi retry" });
    }
  });

  app.delete("/admin/api/listings", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const id = (req.body?.id as string) || (req.query.id as string) || "";
      const resolved = await resolveListingPath(id);
      if (!resolved) return res.status(400).json({ error: "Id không hợp lệ" });
      if (!(await fs.pathExists(resolved.full))) {
        return res.status(404).json({ error: "File đã bị xoá" });
      }
      await fs.remove(resolved.full);
      const errLog = `${resolved.full}.error.log`;
      if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi xoá" });
    }
  });

  // ── History ───────────────────────────────────────────────
  app.get("/admin/api/history", async (req, res) => {
    try {
      const status = req.query.status as "success" | "fail" | undefined;
      const folder = (req.query.folder as string) || undefined;
      const offset = Number(req.query.offset ?? 0);
      const limit = Math.min(200, Number(req.query.limit ?? 50));
      const result = await historyStore.list({ status, folder, offset, limit });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy history" });
    }
  });

  app.get("/admin/api/history/:id/json", async (req, res) => {
    try {
      const entry = await historyStore.find(req.params.id);
      if (!entry) return res.status(404).json({ error: "Không tìm thấy entry" });
      const baseDir = config.baseSheinAutoDir;
      const dir = entry.status === "success" ? "Success" : "Fail";
      const filePath = path.join(baseDir, entry.folder, dir, entry.file);
      if (!(await fs.pathExists(filePath))) {
        return res.status(404).json({ error: "File JSON đã bị xoá hoặc di chuyển" });
      }
      const raw = await fs.readFile(filePath, "utf-8");
      res.json({ entry, content: JSON.parse(raw) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc file JSON" });
    }
  });

  app.post("/admin/api/history/:id/retry", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") {
        return res.status(403).json({ error: "Viewer không thể retry" });
      }
      const entry = await historyStore.find(req.params.id);
      if (!entry || entry.status !== "fail") {
        return res.status(400).json({ error: "Chỉ retry được entry fail" });
      }
      const failPath = path.join(config.baseSheinAutoDir, entry.folder, "Fail", entry.file);
      const targetPath = path.join(config.baseSheinAutoDir, entry.folder, entry.file);
      if (!(await fs.pathExists(failPath))) {
        return res.status(404).json({ error: "File không còn trong Fail" });
      }
      await fs.move(failPath, targetPath, { overwrite: true });
      // Cleanup error log nếu có
      const errLog = `${failPath}.error.log`;
      if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi retry" });
    }
  });

  // ── Settings ─────────────────────────────────────────────
  const SETTINGS_FILE = path.resolve(process.cwd(), "data", "settings.json");

  app.get("/admin/api/settings", async (_req, res) => {
    try {
      const w = workerConfig();
      const overrides = (await fs.pathExists(SETTINGS_FILE))
        ? JSON.parse(await fs.readFile(SETTINGS_FILE, "utf-8"))
        : {};
      res.json({
        concurrency: w.concurrency,
        headless: w.headless,
        fileRouterCron: config.cronFileRouter,
        queueManagerCron: config.cronQueueManager,
        downloadDir: config.downloadDir,
        baseSheinAutoDir: config.baseSheinAutoDir,
        geminiApiKeySet: !!config.geminiApiKey,
        telegram: {
          enabled: !!(config.telegramBotToken && config.telegramChatId),
          chatIdSet: !!config.telegramChatId,
        },
        overrides,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc settings" });
    }
  });

  app.post("/admin/api/settings", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const body = req.body as Partial<{
        concurrency: number;
        headless: boolean;
        fileRouterCron: string;
        queueManagerCron: string;
        imageUploadWaitPerImageMs: number;
        imageUploadMaxImages: number;
        descriptionImagesCount: number;
        descriptionMaxAttributes: number;
      }>;

      const workerJsonPath = path.resolve(process.cwd(), "config", "worker.json");
      const current = JSON.parse(await fs.readFile(workerJsonPath, "utf-8"));
      const merged = { ...current, ...body };
      await fs.writeFile(workerJsonPath, JSON.stringify(merged, null, 2), "utf-8");
      reloadAppConfig();
      res.json({ ok: true, settings: merged });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu settings" });
    }
  });

  // ── Brand mapping per shop profile ───────────────────────
  const BRAND_FILE = path.resolve(process.cwd(), "config", "brand-profiles.json");

  app.get("/admin/api/brands", async (_req, res) => {
    try {
      const raw = await fs.readFile(BRAND_FILE, "utf-8");
      const cfg = JSON.parse(raw);
      res.json({
        default: cfg.default ?? "LUSHLACE",
        profiles: cfg.profiles ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc brands" });
    }
  });

  app.post("/admin/api/brands", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const body = req.body as { default?: string; profiles?: Record<string, string> };
      const cfg = {
        default: typeof body.default === "string" && body.default ? body.default : "LUSHLACE",
        profiles: {} as Record<string, string>,
      };
      if (body.profiles && typeof body.profiles === "object") {
        for (const [k, v] of Object.entries(body.profiles)) {
          const key = String(k).trim();
          const val = String(v).trim();
          if (key && val) cfg.profiles[key] = val;
        }
      }
      await fs.writeFile(BRAND_FILE, JSON.stringify(cfg, null, 2), "utf-8");
      reloadAppConfig();
      res.json({ ok: true, ...cfg });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu brands" });
    }
  });

  // ── Cookie 4Seller ───────────────────────────────────────
  app.post("/admin/api/cookie", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const body = req.body as { cookie: any[] };
      if (!Array.isArray(body.cookie)) {
        return res.status(400).json({ error: "Body phải có field 'cookie' là array" });
      }
      await fs.writeFile(config.cookieFile, JSON.stringify(body.cookie, null, 2), "utf-8");
      res.json({ ok: true, count: body.cookie.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu cookie" });
    }
  });

  app.post("/admin/api/cookie/test", async (_req, res) => {
    let browser: any = null;
    try {
      const cookie = await configCookie("listing4seller");
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext();
      await ctx.addCookies(cookie);
      const page = await ctx.newPage();
      const resp = await page.goto(
        "https://www.4seller.com/web/listing/tiktok/create.html?status=draft",
        { timeout: 20000, waitUntil: "domcontentloaded" }
      );
      const finalUrl = page.url();
      const ok = !!resp && resp.status() < 400 && !finalUrl.includes("login");
      await ctx.close();
      res.json({ ok, finalUrl, status: resp?.status() ?? null });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? "Lỗi test cookie" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  const port = Number(process.env.ADMIN_PORT ?? 3000);
  app.listen(port, () => {
    console.log(`🌐 Admin UI đang chạy tại http://localhost:${port}/admin`);
  });
};
