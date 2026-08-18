import express from "express";
import session from "express-session";
import cors from "cors";
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
  generateApiToken,
  findUserByToken,
} from "./adminConfig";
import { config } from "./config";
import { workerState } from "./state/workerState";
import { refreshQueueSnapshot } from "./state/queueState";
import { historyStore } from "./state/historyStore";
import { scanListings, scanShopsSummary, resolveListingPath, scanHub, resolveHubFile, recordHubListings, removeHubMeta, ListingStatus } from "./state/listingScan";
import { validatePath, detectDirConflicts, getUserDirsByName, getShopOwner } from "./state/userDirs";
import { processFile } from "./queue/queueManager";
import { eventBus } from "./state/eventBus";
import { workerConfig, reloadAppConfig } from "./config/appConfig";
import { configCookie, userCookiePath } from "./utils/configCookie";

const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "shein-auto-secret";

type SessionUser = { username: string; role: "admin" | "editor" | "viewer" };

const sanitizeUserForUi = (user: AdminUser) => ({
  username: user.username,
  password: "",
  role: user.role,
  apiToken: user.apiToken ?? "",
  profiles: user.profiles,
  downloadDir: user.downloadDir ?? "",
  baseSheinAutoDir: user.baseSheinAutoDir ?? "",
  autoCronOverride: user.autoCronOverride ?? null,
  headlessOverride: user.headlessOverride ?? null,
  shipFeeOverride: user.shipFeeOverride ?? null,
  multiplierOverride: user.multiplierOverride ?? null,
  extraAddOverride: user.extraAddOverride ?? null,
  brandProfilesOverride: user.brandProfilesOverride ?? null,
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
      req.path.startsWith("/admin/api/ingest") || // tampermonkey: Bearer token auth riêng
      req.path === "/admin/api/hub/ingest" || // tampermonkey đẩy vào Hub: Bearer token riêng
      req.path === "/admin/api/hub/check" || // tampermonkey pre-check trùng Hub: Bearer token riêng
      req.path === "/admin/login" ||
      req.path === "/admin/logout"
    ) {
      return next();
    }
    if (req.path.startsWith("/admin/api/")) {
      return res.status(401).json({ error: "Chưa đăng nhập" });
    }
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

  // ── Screenshot debug (chỉ cho session đã auth) ────────
  const SCREENSHOT_DIR = path.resolve(process.cwd(), "data", "screenshots");
  app.get("/admin/data/screenshots/:file", async (req, res) => {
    try {
      const fileName = req.params.file;
      // Path traversal guard
      if (!/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/i.test(fileName)) {
        return res.status(400).send("Invalid filename");
      }
      const full = path.join(SCREENSHOT_DIR, fileName);
      if (!(await fs.pathExists(full))) return res.status(404).send("Not found");
      res.sendFile(full);
    } catch (err: any) {
      res.status(500).send(err?.message ?? "Error");
    }
  });

  // ── API token (cho tampermonkey scraper) ──────────────
  app.get("/admin/api/me/token", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (!sessionUser) return res.status(401).json({ error: "Chưa đăng nhập" });
      const cfg = await loadAdminConfig();
      const me = cfg.users.find((u) => u.username === sessionUser.username);
      if (!me) return res.status(404).json({ error: "Không tìm thấy user" });
      res.json({ token: me.apiToken ?? "" });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc token" });
    }
  });

  app.post("/admin/api/me/token/regen", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (!sessionUser) return res.status(401).json({ error: "Chưa đăng nhập" });
      const cfg = await loadAdminConfig();
      const me = cfg.users.find((u) => u.username === sessionUser.username);
      if (!me) return res.status(404).json({ error: "Không tìm thấy user" });
      me.apiToken = generateApiToken();
      await saveAdminConfig(cfg);
      res.json({ token: me.apiToken });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi regen token" });
    }
  });

  // ── Ingest API (cho tampermonkey scraper, Bearer token auth) ──
  const ingestRouter = express.Router();
  ingestRouter.use(
    cors({
      // Cho phép request từ shein.com / .co.uk / .de / .fr ...
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // server-to-server / curl
        if (/^https?:\/\/([a-z0-9-]+\.)?shein\.(com|co\.uk|de|fr|it|es|cn)$/i.test(origin)) {
          return cb(null, true);
        }
        cb(new Error(`Origin "${origin}" không được phép`));
      },
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  const ingestAuth: express.RequestHandler = async (req, res, next) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ")
      ? auth.slice(7).trim()
      : ((req.query.token as string) || "").trim();
    if (!token) return res.status(401).json({ error: "Thiếu Bearer token" });
    const user = await findUserByToken(token);
    if (!user) return res.status(401).json({ error: "Token không hợp lệ" });
    (req as any).tokenUser = user;
    next();
  };

  ingestRouter.get("/profiles", ingestAuth, async (req, res) => {
    try {
      const user = (req as any).tokenUser as AdminUser;
      const explicit = user.profiles ?? [];
      // Nếu user khai báo profiles list cứng → dùng list đó
      if (explicit.length > 0) {
        return res.json({ username: user.username, profiles: explicit, source: "explicit" });
      }
      // Profiles rỗng = "tất cả shop trong baseDir của user"
      // Auto-scan để tampermonkey luôn có list mới nhất
      const dirs = await getUserDirsByName(user.username);
      if (!dirs?.baseSheinAutoDir || !(await fs.pathExists(dirs.baseSheinAutoDir))) {
        return res.json({ username: user.username, profiles: [], source: "empty" });
      }
      const entries = await fs.readdir(dirs.baseSheinAutoDir);
      const shops: string[] = [];
      for (const name of entries) {
        if (name.startsWith(".") || name === "Success" || name === "Fail") continue;
        try {
          const stats = await fs.stat(path.join(dirs.baseSheinAutoDir, name));
          if (stats.isDirectory()) shops.push(name);
        } catch {
          // ignore
        }
      }
      shops.sort();
      res.json({ username: user.username, profiles: shops, source: "auto-scan" });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi load profiles" });
    }
  });

  ingestRouter.post("/check", ingestAuth, async (req, res) => {
    try {
      const user = (req as any).tokenUser as AdminUser;
      const { productId, shops } = req.body as { productId?: string; shops?: string[] };
      if (!productId) return res.status(400).json({ error: "Thiếu productId" });
      const userShops = Array.isArray(shops) ? shops : user.profiles ?? [];
      const dirs = await getUserDirsByName(user.username);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });
      }
      const existsIn: string[] = [];
      for (const shop of userShops) {
        // Check trong pending + Success + Fail folder của shop
        for (const sub of ["", "Success", "Fail"]) {
          const dir = sub
            ? path.join(dirs.baseSheinAutoDir, shop, sub)
            : path.join(dirs.baseSheinAutoDir, shop);
          if (!(await fs.pathExists(dir))) continue;
          const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
          // Grep cho productId trong filenames hoặc content
          let found = files.some((f) => f.includes(productId));
          if (!found) {
            for (const f of files) {
              try {
                const raw = await fs.readFile(path.join(dir, f), "utf-8");
                if (raw.includes(productId)) { found = true; break; }
              } catch {}
            }
          }
          if (found) { existsIn.push(shop); break; }
        }
      }
      res.json({ existsIn });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi check" });
    }
  });

  ingestRouter.post("/", ingestAuth, async (req, res) => {
    try {
      const user = (req as any).tokenUser as AdminUser;
      const { data, shops } = req.body as { data?: any; shops?: string[] };
      if (!data || typeof data !== "object") {
        return res.status(400).json({ error: "Thiếu field data (JSON sản phẩm)" });
      }
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.status(400).json({ error: "Phải chọn ít nhất 1 shop" });
      }
      const dirs = await getUserDirsByName(user.username);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });
      }
      // Validate shops trong profiles user (nếu có profiles list)
      if ((user.profiles ?? []).length > 0) {
        const allowed = new Set(user.profiles);
        const invalid = shops.filter((s) => !allowed.has(s));
        if (invalid.length > 0) {
          return res.status(403).json({ error: `User không có quyền vào shops: ${invalid.join(", ")}` });
        }
      }
      const timestamp = Date.now();
      const written: { shop: string; file: string }[] = [];
      console.log(`📥 [INGEST] user=${user.username} shops=${JSON.stringify(shops)} timestamp=${timestamp}`);
      for (const shop of shops) {
        // Defensive: chặn path traversal (shop chứa / hoặc \ hoặc ..)
        if (/[\/\\]|\.\./.test(shop)) {
          console.warn(`⚠️ [INGEST] Refused shop name with path chars: "${shop}"`);
          continue;
        }
        const folderPath = path.join(dirs.baseSheinAutoDir, shop);
        await fs.ensureDir(folderPath);
        const fileName = `${shop}_${timestamp}.json`;
        const fullPath = path.join(folderPath, fileName);
        await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf-8");
        console.log(`📥 [INGEST] Wrote: ${fullPath}`);
        written.push({ shop, file: fileName });
      }
      // Refresh queue snapshot để dashboard cập nhật
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, queued: written, ts: timestamp });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi ingest" });
    }
  });

  // SSE riêng cho tampermonkey: auth bằng query token, filter event theo owner
  ingestRouter.get("/stream", ingestAuth, (req, res) => {
    const user = (req as any).tokenUser as AdminUser;
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
    send("hello", { ts: Date.now(), user: user.username });

    const onHistory = (entry: any) => {
      // Chỉ push event nếu file thuộc shop của user
      const userShops = user.profiles ?? [];
      if (userShops.length > 0 && !userShops.includes(entry.folder)) return;
      send("history", entry);
    };
    const onWorker = (snap: any) => send("worker", snap);
    const keepalive = setInterval(() => res.write(":\n\n"), 15000);

    eventBus.on("history", onHistory);
    eventBus.on("worker:state", onWorker);
    req.on("close", () => {
      clearInterval(keepalive);
      eventBus.off("history", onHistory);
      eventBus.off("worker:state", onWorker);
    });
  });

  app.use("/admin/api/ingest", ingestRouter);

  // ── Path validator ─────────────────────────────────────
  app.post("/admin/api/path/test", async (req, res) => {
    try {
      const p = (req.body?.path as string) || "";
      const result = await validatePath(p);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi test path" });
    }
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

        // Validate path conflicts (downloadDir/baseSheinAutoDir không trùng/lồng nhau)
        const conflictMsg = detectDirConflicts(
          payload.users.map((u) => ({
            username: u.username,
            downloadDir: u.downloadDir,
            baseSheinAutoDir: u.baseSheinAutoDir,
          }))
        );
        if (conflictMsg) {
          return res.status(400).json({ error: conflictMsg });
        }

        const merged = payload.users.map((u) => {
          const existing = cfg.users.find((it) => it.username === u.username);
          return {
            username: u.username,
            password: u.password ? hashPassword(u.password) : existing?.password ?? "",
            role: u.role,
            // GIỮ token cũ — tránh bug wipe token mỗi lần admin lưu config.
            // Token chỉ đổi qua route regen riêng.
            apiToken: existing?.apiToken ?? u.apiToken ?? "",
            profiles: Array.isArray(u.profiles) ? u.profiles : [],
            downloadDir: typeof u.downloadDir === "string" ? u.downloadDir : existing?.downloadDir ?? "",
            baseSheinAutoDir:
              typeof u.baseSheinAutoDir === "string" ? u.baseSheinAutoDir : existing?.baseSheinAutoDir ?? "",
            autoCronOverride: u.autoCronOverride === undefined
              ? existing?.autoCronOverride ?? null
              : u.autoCronOverride,
            headlessOverride: u.headlessOverride === undefined
              ? existing?.headlessOverride ?? null
              : u.headlessOverride,
            shipFeeOverride: u.shipFeeOverride === undefined
              ? existing?.shipFeeOverride ?? null
              : u.shipFeeOverride,
            multiplierOverride: u.multiplierOverride === undefined
              ? existing?.multiplierOverride ?? null
              : u.multiplierOverride,
            extraAddOverride: u.extraAddOverride === undefined
              ? existing?.extraAddOverride ?? null
              : u.extraAddOverride,
            brandProfilesOverride: u.brandProfilesOverride === undefined
              ? existing?.brandProfilesOverride ?? null
              : u.brandProfilesOverride,
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
      if (updatedUser.autoCronOverride !== undefined) {
        existingUser.autoCronOverride = updatedUser.autoCronOverride;
      }
      if (updatedUser.headlessOverride !== undefined) {
        existingUser.headlessOverride = updatedUser.headlessOverride;
      }
      if (updatedUser.shipFeeOverride !== undefined) {
        existingUser.shipFeeOverride = updatedUser.shipFeeOverride;
      }
      if (updatedUser.multiplierOverride !== undefined) {
        existingUser.multiplierOverride = updatedUser.multiplierOverride;
      }
      if (updatedUser.extraAddOverride !== undefined) {
        existingUser.extraAddOverride = updatedUser.extraAddOverride;
      }
      if (updatedUser.brandProfilesOverride !== undefined) {
        existingUser.brandProfilesOverride = updatedUser.brandProfilesOverride;
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

  /**
   * Danh sách shop folders user được phép xem. Admin → undefined (xem tất cả).
   * Non-admin → list folders theo profiles user khai báo, hoặc scan baseDir nếu profiles rỗng.
   */
  const accessibleFolders = async (req: express.Request): Promise<string[] | undefined> => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "admin") return undefined;
    const dirs = await getUserDirsByName(sessionUser.username);
    if (!dirs) return [];
    if (dirs.profiles.length > 0) return dirs.profiles;
    if (!dirs.baseSheinAutoDir || !(await fs.pathExists(dirs.baseSheinAutoDir))) return [];
    const entries = await fs.readdir(dirs.baseSheinAutoDir);
    return entries.filter((n) => !n.startsWith(".") && n !== "Success" && n !== "Fail");
  };

  // ── Listings (product cards view) ────────────────────────
  // Tạo shop folder mới trong baseSheinAutoDir của user đang login.
  // Nếu user có profiles explicit, auto-append shop mới vào profiles của họ.
  app.post("/admin/api/listings/create-shop", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể tạo shop" });

      const shopRaw = (req.body?.shop as string) || "";
      const shop = shopRaw.trim();
      // Validate: P\d-\d{3} hoặc P\d-\d{3}_XX (vd P5-014, P5-014_DE)
      if (!/^P\d-\d{3}(_[A-Z]{2})?$/i.test(shop)) {
        return res.status(400).json({
          error: "Tên shop không hợp lệ. Phải dạng P5-014 hoặc P5-014_DE/_US/_UK/_FR/...",
        });
      }

      const dirs = await getUserDirsByName(sessionUser.username);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({
          error: "User chưa cấu hình baseSheinAutoDir. Vào Users tab để thiết lập.",
        });
      }

      const target = path.join(dirs.baseSheinAutoDir, shop);
      if (await fs.pathExists(target)) {
        return res.status(400).json({ error: `Shop "${shop}" đã tồn tại.` });
      }

      await fs.ensureDir(target);

      // Nếu user có profiles explicit, append shop vào list để vẫn thấy được sau khi tạo
      const fullCfg = await loadAdminConfig();
      const me = fullCfg.users.find((u) => u.username === sessionUser.username);
      if (me && (me.profiles?.length ?? 0) > 0 && !me.profiles.includes(shop)) {
        me.profiles.push(shop);
        await saveAdminConfig(fullCfg);
      }

      res.json({ ok: true, shop, path: target, appendedToProfiles: !!(me && me.profiles.length > 0) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi tạo shop" });
    }
  });

  app.get("/admin/api/listings/shops", async (req, res) => {
    try {
      const shops = await scanShopsSummary({
        username: ownerScope(req),
        includeEmptyProfiles: req.query.all === "1",
      });
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

  // Retry nhiều listing Fail cùng lúc — mỗi file được đưa về folder shop
  // (→ pending) để cron pick lên. Bỏ qua file không phải fail / không có quyền.
  app.post("/admin/api/listings/retry-batch", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể retry" });

      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 listing" });
      }

      const moved: { id: string; folder: string }[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const id of ids) {
        const resolved = await resolveListingPath(id);
        if (!resolved) { skipped.push({ id, reason: "id không hợp lệ" }); continue; }
        if (resolved.status !== "fail") {
          skipped.push({ id, reason: `không phải fail (${resolved.status})` });
          continue;
        }
        if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
          skipped.push({ id, reason: "không có quyền" });
          continue;
        }
        if (!(await fs.pathExists(resolved.full))) {
          skipped.push({ id, reason: "file không còn ở Fail" });
          continue;
        }
        const target = path.join(resolved.baseDir, resolved.folder, resolved.file);
        await fs.move(resolved.full, target, { overwrite: true });
        const errLog = `${resolved.full}.error.log`;
        if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
        moved.push({ id, folder: resolved.folder });
      }

      res.json({ ok: true, moved, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi retry-batch" });
    }
  });

  // Run nhiều listing pending cùng lúc, mỗi file chạy trên shop hiện tại
  // (không broadcast). Spawn parallel — lock per (baseDir, folder) đảm bảo
  // không 2 file cùng shop chạy đồng thời.
  app.post("/admin/api/listings/run-batch", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể run" });

      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 listing" });
      }

      const spawned: { id: string; folder: string; file: string }[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const id of ids) {
        const resolved = await resolveListingPath(id);
        if (!resolved) { skipped.push({ id, reason: "id không hợp lệ" }); continue; }
        if (resolved.status !== "pending") {
          skipped.push({ id, reason: `không phải pending (${resolved.status})` });
          continue;
        }
        if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
          skipped.push({ id, reason: "không có quyền" });
          continue;
        }
        if (!(await fs.pathExists(resolved.full))) {
          skipped.push({ id, reason: "file đã mất" });
          continue;
        }
        spawned.push({ id, folder: resolved.folder, file: resolved.file });
        // Owner thật của shop (theo profiles explicit) thay vì merged dedup
        const trueOwner = (await getShopOwner(resolved.folder)) || resolved.owner.split(",")[0];
        // Fire-and-forget — processFile có lock per (baseDir, folder)
        processFile(resolved.baseDir, resolved.folder, resolved.file, trueOwner)
          .catch((err) => console.error(`❌ run-batch ${resolved.folder}/${resolved.file}:`, err));
      }

      res.json({ ok: true, spawned, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi run-batch" });
    }
  });

  // Run 1 listing trên N shops ngay lập tức (bỏ qua cron). Broadcast = copy
  // JSON gốc sang shop khác trước khi chạy nếu shop đó chưa có file.
  app.post("/admin/api/listings/run-now", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể run" });

      const { id, shops } = req.body as { id?: string; shops?: string[] };
      if (!id) return res.status(400).json({ error: "Thiếu id listing" });
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 shop" });
      }

      const resolved = await resolveListingPath(id);
      if (!resolved) return res.status(400).json({ error: "Id không hợp lệ" });
      if (resolved.status !== "pending") {
        return res.status(400).json({ error: "Chỉ run được listing pending. Status hiện tại: " + resolved.status });
      }
      if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
        return res.status(403).json({ error: "Không có quyền run listing này" });
      }
      if (!(await fs.pathExists(resolved.full))) {
        return res.status(404).json({ error: "File pending không còn tồn tại" });
      }

      const dirs = await getUserDirsByName(resolved.owner.split(",")[0]);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });
      }

      // Đọc JSON gốc 1 lần
      const sourceJson = await fs.readFile(resolved.full, "utf-8");
      const baseName = resolved.file;

      const spawned: { shop: string; file: string }[] = [];
      const skipped: { shop: string; reason: string }[] = [];

      for (const targetShop of shops) {
        const targetFolder = path.join(dirs.baseSheinAutoDir, targetShop);
        await fs.ensureDir(targetFolder);
        const targetPath = path.join(targetFolder, baseName);

        // Nếu shop đích chính là shop hiện tại → dùng file gốc
        // Nếu khác → copy JSON (không di chuyển file gốc — sẽ được consume bởi shop của nó)
        if (targetShop !== resolved.folder) {
          if (await fs.pathExists(targetPath)) {
            skipped.push({ shop: targetShop, reason: "đã có file cùng tên" });
            continue;
          }
          await fs.writeFile(targetPath, sourceJson, "utf-8");
        }

        spawned.push({ shop: targetShop, file: baseName });
        // Owner thật của targetShop (theo profiles explicit) → đúng cookie/preferences
        const trueOwner = (await getShopOwner(targetShop)) || resolved.owner.split(",")[0];
        // Fire-and-forget — processFile có lock per (baseDir, folder)
        processFile(dirs.baseSheinAutoDir, targetShop, baseName, trueOwner).catch((err) => {
          console.error(`❌ run-now ${targetShop}/${baseName} crashed:`, err);
        });
      }

      res.json({ ok: true, spawned, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi run-now" });
    }
  });

  // Clone N listing SUCCESS sang nhiều shop đích (kể cả khác user). Chỉ COPY file
  // JSON vào shop đích dạng pending (không spawn — cron chạy sau). Mỗi shop đích
  // resolve baseDir RIÊNG theo owner của shop đó (khác run-now dùng chung baseDir).
  app.post("/admin/api/listings/clone", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể clone" });

      const { ids, shops } = req.body as { ids?: string[]; shops?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 listing" });
      }
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 shop đích" });
      }

      const cloned: { id: string; shop: string; file: string }[] = [];
      const skipped: { id?: string; shop?: string; reason: string }[] = [];

      // 1) Resolve baseDir + owner cho từng shop đích 1 lần
      const targets = new Map<string, { base: string; owner: string }>();
      for (const shop of shops) {
        if (/[\/\\]|\.\./.test(shop)) { skipped.push({ shop, reason: "tên shop không hợp lệ" }); continue; }
        const owner = await getShopOwner(shop);
        if (!owner) { skipped.push({ shop, reason: "không tìm được owner của shop" }); continue; }
        if (sessionUser.role !== "admin" && owner !== sessionUser.username) {
          skipped.push({ shop, reason: "không có quyền ghi shop này" });
          continue;
        }
        const dirs = await getUserDirsByName(owner);
        if (!dirs?.baseSheinAutoDir) { skipped.push({ shop, reason: "owner chưa cấu hình baseSheinAutoDir" }); continue; }
        targets.set(shop, { base: dirs.baseSheinAutoDir, owner });
      }
      if (targets.size === 0) {
        return res.status(400).json({ error: "Không có shop đích hợp lệ", skipped });
      }

      // 2) Với mỗi listing nguồn (chỉ success) → copy sang mọi shop đích hợp lệ
      let counter = 0;
      for (const id of ids) {
        const resolved = await resolveListingPath(id);
        if (!resolved) { skipped.push({ id, reason: "id không hợp lệ" }); continue; }
        if (resolved.status !== "success") {
          skipped.push({ id, reason: `không phải success (${resolved.status})` });
          continue;
        }
        if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
          skipped.push({ id, reason: "không có quyền clone listing này" });
          continue;
        }
        if (!(await fs.pathExists(resolved.full))) {
          skipped.push({ id, reason: "file nguồn không còn tồn tại" });
          continue;
        }
        const raw = await fs.readFile(resolved.full, "utf-8");

        for (const [shop, { base }] of targets) {
          const folderPath = path.join(base, shop);
          await fs.ensureDir(folderPath);
          const fileName = `${shop}_${Date.now()}_${counter++}.json`;
          await fs.writeFile(path.join(folderPath, fileName), raw, "utf-8");
          cloned.push({ id, shop, file: fileName });
        }
      }

      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, cloned, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi clone" });
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

  // Xoá nhiều listing cùng lúc (admin). Xoá hẳn file JSON + error log.
  app.post("/admin/api/listings/delete-batch", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Chọn ít nhất 1 listing" });
      }

      const removed: string[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const id of ids) {
        const resolved = await resolveListingPath(id);
        if (!resolved) { skipped.push({ id, reason: "id không hợp lệ" }); continue; }
        if (!(await fs.pathExists(resolved.full))) { skipped.push({ id, reason: "file đã bị xoá" }); continue; }
        await fs.remove(resolved.full);
        const errLog = `${resolved.full}.error.log`;
        if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
        removed.push(id);
      }

      res.json({ ok: true, removed, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi xoá hàng loạt" });
    }
  });

  // ── HUB sản phẩm (kho chung toàn hệ thống) ─────────────────
  // productId SHEIN của 1 sản phẩm (từ url -p-<id>.html, fallback variant_ids).
  const extractProductId = (data: any): string | null => {
    const url = typeof data?.url === "string" ? data.url : "";
    const m = url.match(/-p-(\d+)\.html/);
    if (m) return m[1];
    if (Array.isArray(data?.variant_ids)) {
      for (const v of data.variant_ids) {
        const id = Object.values(v || {})[0];
        if (id && /^\d+$/.test(String(id))) return String(id);
      }
    }
    return null;
  };

  // Tập productId đã có sẵn trong Hub (bỏ file meta). Đọc mỗi file 1 lần.
  const buildHubProductIds = async (): Promise<Set<string>> => {
    const set = new Set<string>();
    if (!(await fs.pathExists(config.hubDir))) return set;
    const files = (await fs.readdir(config.hubDir)).filter(
      (f) => f.toLowerCase().endsWith(".json") && f !== "__hub_meta.json"
    );
    for (const f of files) {
      try {
        const id = extractProductId(JSON.parse(await fs.readFile(path.join(config.hubDir, f), "utf-8")));
        if (id) set.add(id);
      } catch { /* ignore */ }
    }
    return set;
  };

  // Ghi 1 file JSON vào hub. Dùng chung cho userscript (Bearer) + kéo từ shop.
  const writeHubFile = async (data: any): Promise<string> => {
    await fs.ensureDir(config.hubDir);
    const fileName = `hub_${Date.now()}_${Math.floor(Math.random() * 1e6)}.json`;
    await fs.writeFile(path.join(config.hubDir, fileName), JSON.stringify(data, null, 2), "utf-8");
    return fileName;
  };

  // Userscript đẩy sản phẩm cào được vào Hub (Bearer token, không cần shop).
  app.post("/admin/api/hub/ingest", ingestAuth, async (req, res) => {
    try {
      const { data } = req.body as { data?: any };
      if (!data || typeof data !== "object") return res.status(400).json({ error: "Thiếu data" });
      // Bỏ qua nếu productId đã có trong Hub
      const pid = extractProductId(data);
      if (pid && (await buildHubProductIds()).has(pid)) {
        return res.json({ ok: true, duplicate: true });
      }
      const file = await writeHubFile(data);
      res.json({ ok: true, file, duplicate: false });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi ingest hub" });
    }
  });

  // Userscript pre-check: sản phẩm (productId) đã có trong Hub chưa (trước khi cào).
  app.post("/admin/api/hub/check", ingestAuth, async (req, res) => {
    try {
      const { productId } = req.body as { productId?: string };
      if (!productId) return res.json({ exists: false });
      const exists = (await buildHubProductIds()).has(String(productId));
      res.json({ exists });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi check hub" });
    }
  });

  // Liệt kê sản phẩm trong Hub.
  app.get("/admin/api/hub", async (_req, res) => {
    try {
      const items = await scanHub();
      res.json({ items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi scan hub" });
    }
  });

  // Xem JSON gốc 1 sản phẩm Hub.
  app.get("/admin/api/hub/json", async (req, res) => {
    try {
      const full = resolveHubFile((req.query.file as string) || "");
      if (!full || !(await fs.pathExists(full))) return res.status(404).json({ error: "File không tồn tại" });
      const content = JSON.parse(await fs.readFile(full, "utf-8"));
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc file hub" });
    }
  });

  // Kéo listing có sẵn (mọi status) từ shop vào Hub.
  app.post("/admin/api/hub/add", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể thêm vào Hub" });

      const { ids } = req.body as { ids?: string[] };
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "Chọn ít nhất 1 listing" });

      const hubIds = await buildHubProductIds(); // productId đã có trong Hub
      const added: { id: string; file: string }[] = [];
      const skipped: { id: string; reason: string }[] = [];
      let duplicates = 0;
      for (const id of ids) {
        const resolved = await resolveListingPath(id);
        if (!resolved) { skipped.push({ id, reason: "id không hợp lệ" }); continue; }
        if (sessionUser.role !== "admin" && !resolved.owner.split(",").includes(sessionUser.username)) {
          skipped.push({ id, reason: "không có quyền" }); continue;
        }
        if (!(await fs.pathExists(resolved.full))) { skipped.push({ id, reason: "file không còn" }); continue; }
        const raw = await fs.readFile(resolved.full, "utf-8");
        let data: any;
        try { data = JSON.parse(raw); } catch { skipped.push({ id, reason: "JSON hỏng" }); continue; }
        const pid = extractProductId(data);
        if (pid && hubIds.has(pid)) {
          skipped.push({ id, reason: "trùng — đã có trong Hub" });
          duplicates++;
          continue;
        }
        const file = await writeHubFile(data);
        if (pid) hubIds.add(pid); // tránh trùng trong cùng lượt add
        added.push({ id, file });
      }
      res.json({ ok: true, added, skipped, duplicates });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi thêm vào Hub" });
    }
  });

  // Import sản phẩm vào Hub bằng file JSON (client parse sẵn, gửi mảng object).
  app.post("/admin/api/hub/import", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể import" });

      const { items } = req.body as { items?: any[] };
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Không có sản phẩm để import" });

      const hubIds = await buildHubProductIds();
      let imported = 0, duplicates = 0, invalid = 0;
      for (const data of items) {
        // Phải là object giống sản phẩm (có ít nhất 1 field nhận dạng)
        const looksLikeProduct = data && typeof data === "object" && !Array.isArray(data) &&
          (data.product_name || data.product_images || data.variant_images || data.listing_variations);
        if (!looksLikeProduct) { invalid++; continue; }
        const pid = extractProductId(data);
        if (pid && hubIds.has(pid)) { duplicates++; continue; }
        await writeHubFile(data);
        if (pid) hubIds.add(pid);
        imported++;
      }
      res.json({ ok: true, imported, duplicates, invalid });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi import Hub" });
    }
  });

  // Tập productId đã có trong 1 shop (quét pending + Success + Fail). Đọc mỗi file 1 lần.
  const buildShopProductIds = async (base: string, shop: string): Promise<Set<string>> => {
    const set = new Set<string>();
    for (const sub of ["", "Success", "Fail"]) {
      const dir = sub ? path.join(base, shop, sub) : path.join(base, shop);
      if (!(await fs.pathExists(dir))) continue;
      const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
      for (const f of files) {
        try {
          const id = extractProductId(JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")));
          if (id) set.add(id);
        } catch { /* ignore */ }
      }
    }
    return set;
  };

  // List sản phẩm từ Hub lên nhiều shop (mọi user) — copy dạng pending, cron chạy sau.
  app.post("/admin/api/hub/clone", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể list" });

      const { files, shops } = req.body as { files?: string[]; shops?: string[] };
      if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: "Chọn ít nhất 1 sản phẩm Hub" });
      if (!Array.isArray(shops) || shops.length === 0) return res.status(400).json({ error: "Chọn ít nhất 1 shop đích" });

      // Resolve baseDir + owner + tập productId đã có cho từng shop đích 1 lần.
      const targets = new Map<string, { base: string; owner: string; existing: Set<string> }>();
      const skipped: { file?: string; shop?: string; reason: string }[] = [];
      for (const shop of shops) {
        if (/[\/\\]|\.\./.test(shop)) { skipped.push({ shop, reason: "tên shop không hợp lệ" }); continue; }
        const owner = await getShopOwner(shop);
        if (!owner) { skipped.push({ shop, reason: "không tìm được owner" }); continue; }
        if (sessionUser.role !== "admin" && owner !== sessionUser.username) {
          skipped.push({ shop, reason: "không có quyền ghi shop này" }); continue;
        }
        const dirs = await getUserDirsByName(owner);
        if (!dirs?.baseSheinAutoDir) { skipped.push({ shop, reason: "owner chưa cấu hình baseSheinAutoDir" }); continue; }
        const existing = await buildShopProductIds(dirs.baseSheinAutoDir, shop);
        targets.set(shop, { base: dirs.baseSheinAutoDir, owner, existing });
      }
      if (targets.size === 0) return res.status(400).json({ error: "Không có shop đích hợp lệ", skipped });

      const cloned: { file: string; shop: string; out: string }[] = [];
      let duplicates = 0;
      let counter = 0;
      for (const file of files) {
        const full = resolveHubFile(file);
        if (!full || !(await fs.pathExists(full))) { skipped.push({ file, reason: "file hub không tồn tại" }); continue; }
        const raw = await fs.readFile(full, "utf-8");
        let pid: string | null = null;
        try { pid = extractProductId(JSON.parse(raw)); } catch { /* ignore */ }
        for (const [shop, t] of targets) {
          // Bỏ qua nếu sản phẩm (theo productId) ĐÃ có trong shop đích
          if (pid && t.existing.has(pid)) {
            skipped.push({ file, shop, reason: "trùng — đã có trong shop" });
            duplicates++;
            continue;
          }
          const folderPath = path.join(t.base, shop);
          await fs.ensureDir(folderPath);
          const out = `${shop}_${Date.now()}_${counter++}.json`;
          await fs.writeFile(path.join(folderPath, out), raw, "utf-8");
          if (pid) t.existing.add(pid); // tránh trùng trong cùng lượt list
          cloned.push({ file, shop, out });
        }
      }
      // Ghi nhận thống kê: mỗi hub file đã list lên những shop nào (distinct)
      const fileToShops: Record<string, string[]> = {};
      for (const c of cloned) (fileToShops[c.file] ||= []).push(c.shop);
      if (Object.keys(fileToShops).length) await recordHubListings(fileToShops, Date.now());
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, cloned, skipped, duplicates });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi list từ Hub" });
    }
  });

  // Xoá sản phẩm khỏi Hub.
  app.post("/admin/api/hub/delete", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể xoá" });

      const { files } = req.body as { files?: string[] };
      if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: "Chọn ít nhất 1 sản phẩm" });

      const removed: string[] = [];
      const skipped: { file: string; reason: string }[] = [];
      for (const file of files) {
        const full = resolveHubFile(file);
        if (!full) { skipped.push({ file, reason: "tên file không hợp lệ" }); continue; }
        if (!(await fs.pathExists(full))) { skipped.push({ file, reason: "đã xoá" }); continue; }
        await fs.remove(full);
        removed.push(file);
      }
      await removeHubMeta(removed);
      res.json({ ok: true, removed, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi xoá Hub" });
    }
  });

  // ── History ───────────────────────────────────────────────
  app.get("/admin/api/history", async (req, res) => {
    try {
      const status = req.query.status as "success" | "fail" | undefined;
      const folder = (req.query.folder as string) || undefined;
      const offset = Number(req.query.offset ?? 0);
      const limit = Math.min(200, Number(req.query.limit ?? 50));

      // Scope theo quyền user. Admin → undefined = tất cả.
      // Non-admin → list folders accessible, nếu rỗng = không xem được gì.
      const folders = await accessibleFolders(req);

      const result = await historyStore.list({ status, folder, folders, offset, limit });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy history" });
    }
  });

  /** Helper: check user có quyền xem entry này không (theo folder) */
  const canAccessEntry = async (req: express.Request, entryFolder: string): Promise<boolean> => {
    const folders = await accessibleFolders(req);
    if (folders === undefined) return true; // admin
    return folders.includes(entryFolder);
  };

  app.get("/admin/api/history/:id/json", async (req, res) => {
    try {
      const entry = await historyStore.find(req.params.id);
      if (!entry) return res.status(404).json({ error: "Không tìm thấy entry" });
      if (!(await canAccessEntry(req, entry.folder))) {
        return res.status(403).json({ error: "Không có quyền xem entry này" });
      }
      // BaseDir của user owner (lấy từ profile owner, fallback global)
      const sessionUser = (req.session as any).user as SessionUser;
      const dirs = await getUserDirsByName(sessionUser.username);
      const baseDir = dirs?.baseSheinAutoDir || config.baseSheinAutoDir;
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
      if (!(await canAccessEntry(req, entry.folder))) {
        return res.status(403).json({ error: "Không có quyền retry entry này" });
      }
      const dirs = await getUserDirsByName(sessionUser.username);
      const baseDir = dirs?.baseSheinAutoDir || config.baseSheinAutoDir;
      const failPath = path.join(baseDir, entry.folder, "Fail", entry.file);
      const targetPath = path.join(baseDir, entry.folder, entry.file);
      if (!(await fs.pathExists(failPath))) {
        return res.status(404).json({ error: "File không còn trong Fail" });
      }
      await fs.move(failPath, targetPath, { overwrite: true });
      const errLog = `${failPath}.error.log`;
      if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi retry" });
    }
  });

  // ── Settings ─────────────────────────────────────────────
  const SETTINGS_FILE = path.resolve(process.cwd(), "data", "settings.json");

  app.get("/admin/api/settings", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });
      const w = workerConfig();
      const overrides = (await fs.pathExists(SETTINGS_FILE))
        ? JSON.parse(await fs.readFile(SETTINGS_FILE, "utf-8"))
        : {};
      res.json({
        autoCron: w.autoCron,
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
        autoCron: boolean;
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

  // ── Pricing formula ──────────────────────────────────────
  const PRICING_FILE = path.resolve(process.cwd(), "config", "pricing.json");

  app.get("/admin/api/pricing", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });
      const raw = await fs.readFile(PRICING_FILE, "utf-8");
      const cfg = JSON.parse(raw);
      res.json({
        shipFee: typeof cfg.shipFee === "number" ? cfg.shipFee : 5,
        multiplier: typeof cfg.multiplier === "number" ? cfg.multiplier : 1.6,
        extraAdd: typeof cfg.extraAdd === "number" ? cfg.extraAdd : 0,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc pricing" });
    }
  });

  app.post("/admin/api/pricing", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });

      const body = req.body as { shipFee?: number; multiplier?: number; extraAdd?: number };
      const shipFee = Number(body.shipFee);
      const multiplier = Number(body.multiplier);
      const extraAdd = Number(body.extraAdd);

      if (!isFinite(shipFee) || !isFinite(multiplier) || !isFinite(extraAdd)) {
        return res.status(400).json({ error: "Tất cả field phải là số" });
      }
      if (multiplier <= 0) {
        return res.status(400).json({ error: "Multiplier phải > 0" });
      }

      // Merge với defaults sẵn có (qty, weight, dimensions)
      const existing = JSON.parse(await fs.readFile(PRICING_FILE, "utf-8"));
      const merged = { ...existing, shipFee, multiplier, extraAdd };
      // Remove legacy fields nếu có
      delete merged.offset;
      delete merged.divisor;
      await fs.writeFile(PRICING_FILE, JSON.stringify(merged, null, 2), "utf-8");
      reloadAppConfig();
      res.json({ ok: true, shipFee, multiplier, extraAdd });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu pricing" });
    }
  });

  // ── Brand mapping per shop profile ───────────────────────
  const BRAND_FILE = path.resolve(process.cwd(), "config", "brand-profiles.json");

  app.get("/admin/api/brands", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });
      const raw = await fs.readFile(BRAND_FILE, "utf-8");
      const cfg = JSON.parse(raw);
      res.json({
        default: cfg.default ?? "",
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
        default: typeof body.default === "string" ? body.default.trim() : "",
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

  // ── Cookie 4Seller (per-user) ─────────────────────────
  // Resolve user đích cho thao tác cookie. Admin có thể nhắm user bất kỳ (phải
  // tồn tại — chống path traversal); non-admin bị ép về chính mình.
  // Trả về { error, status } nếu không hợp lệ; ngược lại { target }.
  const resolveCookieTarget = async (
    sessionUser: SessionUser,
    requested?: string
  ): Promise<{ target?: string; error?: string; status?: number }> => {
    if (!requested || requested === sessionUser.username) {
      return { target: sessionUser.username };
    }
    if (sessionUser.role !== "admin") {
      return { error: "Chỉ admin mới thao tác cookie cho user khác", status: 403 };
    }
    const cfg = await loadAdminConfig();
    if (!cfg.users.some((u) => u.username === requested)) {
      return { error: `User "${requested}" không tồn tại`, status: 400 };
    }
    return { target: requested };
  };

  // GET: cho UI biết user (mình hoặc — nếu admin — user được chọn) đã upload cookie chưa
  app.get("/admin/api/cookie/status", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const { target, error, status } = await resolveCookieTarget(
        sessionUser,
        (req.query.username as string | undefined)?.trim() || undefined
      );
      if (!target) return res.status(status ?? 400).json({ error });
      const file = userCookiePath(target);
      const exists = await fs.pathExists(file);
      let count = 0;
      let mtime: number | null = null;
      if (exists) {
        try {
          const stat = await fs.stat(file);
          mtime = stat.mtimeMs;
          const raw = await fs.readFile(file, "utf-8");
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed : parsed?.cookies ?? [];
          count = arr.length;
        } catch {
          // ignore parse fail
        }
      }
      res.json({
        username: target,
        userCookie: { exists, count, mtime, path: file },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc status cookie" });
    }
  });

  app.post("/admin/api/cookie", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể upload cookie" });

      const body = req.body as { cookie: any[]; username?: string };
      if (!Array.isArray(body.cookie)) {
        return res.status(400).json({ error: "Body phải có field 'cookie' là array" });
      }
      const { target, error, status } = await resolveCookieTarget(
        sessionUser,
        body.username?.trim() || undefined
      );
      if (!target) return res.status(status ?? 400).json({ error });
      // Mỗi user lưu vào file riêng — không ghi đè user khác
      const targetFile = userCookiePath(target);
      await fs.ensureDir(path.dirname(targetFile));
      await fs.writeFile(targetFile, JSON.stringify(body.cookie, null, 2), "utf-8");
      res.json({ ok: true, count: body.cookie.length, username: target, savedTo: targetFile });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu cookie" });
    }
  });

  app.post("/admin/api/cookie/test", async (req, res) => {
    let browser: any = null;
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const { target, error, status } = await resolveCookieTarget(
        sessionUser,
        (req.body?.username as string | undefined)?.trim() || undefined
      );
      if (!target) return res.status(status ?? 400).json({ ok: false, error });
      // Test cookie của user đích (admin có thể test hộ user khác)
      const cookie = await configCookie(target);
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
      res.json({ ok, finalUrl, status: resp?.status() ?? null, source: target });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? "Lỗi test cookie" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // Tạo/đổi API token cho 1 user (admin: bất kỳ; non-admin: chính mình)
  app.post("/admin/api/user-token/regen", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể tạo token" });
      const { target, error, status } = await resolveCookieTarget(
        sessionUser,
        (req.body?.username as string | undefined)?.trim() || undefined
      );
      if (!target) return res.status(status ?? 400).json({ error });
      const cfg = await loadAdminConfig();
      const u = cfg.users.find((x) => x.username === target);
      if (!u) return res.status(404).json({ error: "Không tìm thấy user" });
      u.apiToken = generateApiToken();
      await saveAdminConfig(cfg);
      res.json({ username: target, token: u.apiToken });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi tạo token" });
    }
  });

  const port = Number(process.env.ADMIN_PORT ?? 3000);
  // Bind port là "single-instance guard": nếu instance khác đã chiếm port →
  // reject (EADDRINUSE) để index.ts thoát hẳn, KHÔNG cho chạy cron song song.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🌐 Admin UI đang chạy tại http://localhost:${port}/admin`);
      resolve();
    });
    server.on("error", (err: any) => {
      if (err?.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} đã bị chiếm — có instance worker khác đang chạy. Thoát.`));
      } else {
        reject(err);
      }
    });
  });
};
