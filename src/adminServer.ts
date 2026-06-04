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
import { scanListings, scanShopsSummary, resolveListingPath, ListingStatus } from "./state/listingScan";
import { validatePath, detectDirConflicts, getUserDirsByName, getShopOwner } from "./state/userDirs";
import { processFile } from "./queue/queueManager";
import { eventBus } from "./state/eventBus";
import { workerConfig, reloadAppConfig } from "./config/appConfig";
import { configCookie, userCookiePath } from "./utils/configCookie";
import {
  getShopList as fsGetShopList,
  getStatusCount as fsGetStatusCount,
  getListingPage as fsGetListingPage,
  getListingDetail as fsGetListingDetail,
  getCategoryById as fsGetCategoryById,
} from "./services/fourseller/client";
import {
  computeShopScore,
  type ScoreListing,
  type CategoryName,
} from "./core/shopScore";
import { analyzeShop, type ShopAnalysisResult } from "./services/gemini/analyzeShop";
import {
  searchProducts as sheinSearch,
  bestSellersByCategory as sheinBestByCategory,
  getProductDetail as sheinGetDetail,
} from "./services/shein/client";
import { rankByWin } from "./core/winScore";
import { findSimilarStores } from "./services/shein/similarStores";
import { scrapeViaKiki, dispatchScrapedData } from "./core/scrapeViaKiki";
import { crawlStoreViaKiki } from "./core/crawlStoreViaKiki";
import { kiki } from "./services/kiki/client";
import { readKikiConfig, saveKikiProfiles } from "./services/kiki/config";
import { scoreWin } from "./core/winScore";
import { runDailyResearch } from "./core/research/dailyResearch";
import { enrichCandidates } from "./core/research/enrichCandidates";
import { validateCandidates } from "./core/research/validateCandidates";
import { generateResearchBriefing } from "./services/gemini/researchInsights";
import { researchStore, today as researchToday } from "./state/researchStore";

const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "shein-auto-secret";

type SessionUser = { username: string; role: "admin" | "editor" | "viewer" };

const sanitizeUserForUi = (user: AdminUser) => ({
  username: user.username,
  password: "",
  role: user.role,
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
      const { getUserDirsByName } = await import("./state/userDirs");
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
      const { getUserDirsByName } = await import("./state/userDirs");
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
      const { getUserDirsByName } = await import("./state/userDirs");
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

  // (Đã bỏ global brand mapping — brand giờ chỉ theo từng user/shop ở mục Users.)

  // ── 4Seller stats — đọc trực tiếp từ 4Seller API ──────
  // Cache nhỏ in-memory để giảm round-trip (TTL 60s)
  const statsCache = new Map<string, { ts: number; data: any }>();
  const STATS_TTL = 60_000;

  app.get("/admin/api/stats/4seller", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const cacheKey = `shops:${sessionUser.username}`;
      const cached = statsCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < STATS_TTL) {
        return res.json({ ...cached.data, cached: true });
      }

      const shopList = await fsGetShopList(sessionUser.username);
      let shops = shopList.records;

      // Filter theo accessibleFolders nếu non-admin
      const accessible = await accessibleFolders(req);
      if (accessible !== undefined) {
        const allowedSet = new Set(accessible.map((s) => s.toLowerCase()));
        shops = shops.filter((s) => {
          const candidates = [
            s.shopName,
            s.platformShopName,
            s.shopName.replace(/^tiktok_/i, ""),
            s.shopName.replace(/_US$|_DE$|_UK$|_FR$|_IT$|_ES$/i, ""),
          ];
          return candidates.some((c) => allowedSet.has(c.toLowerCase()));
        });
      }

      // Lấy count song song
      const withCounts = await Promise.all(
        shops.map(async (s) => {
          try {
            const c = await fsGetStatusCount(sessionUser.username, { shopId: s.id });
            return { ...s, counts: c };
          } catch (err: any) {
            return { ...s, counts: null, error: err?.message ?? "unknown" };
          }
        })
      );

      // Tổng cộng tất cả shop của user
      const totals = withCounts.reduce(
        (acc, s) => {
          const c = s.counts;
          if (c) {
            acc.activeCount += c.activeCount;
            acc.inactiveCount += c.inactiveCount;
            acc.removedCount += c.removedCount;
            acc.suspendedCount += c.suspendedCount;
          }
          return acc;
        },
        { activeCount: 0, inactiveCount: 0, removedCount: 0, suspendedCount: 0 }
      );

      const payload = { shops: withCounts, totals, fetchedAt: Date.now() };
      statsCache.set(cacheKey, { ts: Date.now(), data: payload });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy 4Seller stats" });
    }
  });

  app.get("/admin/api/stats/4seller/detail/:listingId", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const listingId = req.params.listingId;
      if (!/^\d+$/.test(listingId)) {
        return res.status(400).json({ error: "listingId phải là số" });
      }
      const detail = await fsGetListingDetail(sessionUser.username, listingId);
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy detail listing" });
    }
  });

  app.get("/admin/api/stats/4seller/listings", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const shopId = (req.query.shopId as string) || "";
      const status = (req.query.status as any) || "active";
      const pageCurrent = Number(req.query.pageCurrent ?? 1);
      const pageSize = Math.min(100, Number(req.query.pageSize ?? 50));

      const data = await fsGetListingPage(sessionUser.username, {
        shopId: shopId || undefined,
        status,
        pageCurrent,
        pageSize,
      });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy listings 4Seller" });
    }
  });

  // ── 4Seller category analytics ─────────────────────
  // Load tất cả active listings của 1 shop, group by categoryId, resolve tên
  app.get("/admin/api/stats/4seller/category-analytics", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const shopId = (req.query.shopId as string) || "";
      const site = (req.query.site as string) || "US";
      if (!shopId) return res.status(400).json({ error: "shopId required" });

      // Load all pages
      const PAGE_SIZE = 100;
      let pageCurrent = 1;
      let total = 0;
      const catCount: Record<string, number> = {};

      do {
        const data = await fsGetListingPage(sessionUser.username, {
          shopId,
          status: "active",
          pageCurrent,
          pageSize: PAGE_SIZE,
        });
        total = data.total;
        for (const r of data.records) {
          const cid = String(r.categoryId || "unknown");
          catCount[cid] = (catCount[cid] || 0) + 1;
        }
        if (data.records.length < PAGE_SIZE) break;
        pageCurrent++;
      } while ((pageCurrent - 1) * PAGE_SIZE < total);

      // Resolve category names — batch with concurrency 5
      const categoryIds = Object.keys(catCount).filter((id) => id !== "unknown");
      const catNames: Record<string, { name: string; nodePath: string }> = {};

      const BATCH = 5;
      for (let i = 0; i < categoryIds.length; i += BATCH) {
        const batch = categoryIds.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (cid) => {
            try {
              const info = await fsGetCategoryById(sessionUser.username, cid, site, shopId);
              catNames[cid] = { name: info.categoryName, nodePath: info.nodePath };
            } catch {
              catNames[cid] = { name: cid, nodePath: "" };
            }
          })
        );
      }

      // Build result sorted by count desc
      const result = Object.entries(catCount)
        .map(([cid, count]) => ({
          categoryId: cid,
          categoryName: catNames[cid]?.name ?? cid,
          nodePath: catNames[cid]?.nodePath ?? "",
          count,
          percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count);

      res.json({ shopId, site, total, categories: result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi category analytics" });
    }
  });

  // ── 4Seller shop scoring — chấm điểm sức khỏe shop + AI analysis ──
  // Chỉ dùng list API (title/ảnh/ngách/giá/stock). Cache 10 phút.
  const scoreCache = new Map<string, { ts: number; data: any }>();
  const SCORE_TTL = 10 * 60_000;

  app.get("/admin/api/stats/4seller/shop-score", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const shopId = (req.query.shopId as string) || "";
      const shopName = (req.query.shopName as string) || shopId;
      const site = (req.query.site as string) || "US";
      const useAi = req.query.ai !== "0";
      const noCache = req.query.nocache !== undefined;
      if (!shopId) return res.status(400).json({ error: "shopId required" });

      const cacheKey = `score:${sessionUser.username}:${shopId}:${useAi ? "ai" : "noai"}`;
      if (!noCache) {
        const cached = scoreCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < SCORE_TTL) {
          return res.json({ ...cached.data, cached: true });
        }
      }

      // 1. Load toàn bộ active listings (chỉ giữ field cần cho chấm điểm)
      const PAGE_SIZE = 100;
      let pageCurrent = 1;
      let total = 0;
      let currency = "";
      const listings: ScoreListing[] = [];

      do {
        const data = await fsGetListingPage(sessionUser.username, {
          shopId,
          status: "active",
          pageCurrent,
          pageSize: PAGE_SIZE,
        });
        total = data.total;
        for (const r of data.records as any[]) {
          if (!currency && r.currency) currency = r.currency;
          listings.push({
            id: r.id,
            productName: r.productName,
            mainImage: r.mainImage,
            categoryId: r.categoryId,
            lowPrice: r.lowPrice,
            highPrice: r.highPrice,
            originalPrice: r.originalPrice,
            availableStock: r.availableStock,
            variationCount: r.variationCount,
            errMsg: r.errMsg,
            failedMessage: r.failedMessage,
          });
        }
        if (data.records.length < PAGE_SIZE) break;
        pageCurrent++;
      } while ((pageCurrent - 1) * PAGE_SIZE < total);

      if (listings.length === 0) {
        return res.json({ shopId, shopName, site, total: 0, empty: true });
      }

      // 2. Resolve tên category (batch concurrency 5)
      const categoryIds = [
        ...new Set(listings.map((l) => String(l.categoryId || "unknown"))),
      ].filter((id) => id !== "unknown");
      const categoryNames: Record<string, CategoryName> = {};
      const BATCH = 5;
      for (let i = 0; i < categoryIds.length; i += BATCH) {
        const batch = categoryIds.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (cid) => {
            try {
              const info = await fsGetCategoryById(sessionUser.username, cid, site, shopId);
              categoryNames[cid] = { name: info.categoryName, nodePath: info.nodePath };
            } catch {
              categoryNames[cid] = { name: cid, nodePath: "" };
            }
          })
        );
      }

      // 3. Chấm điểm (rule-based)
      const score = computeShopScore(listings, categoryNames);
      score.priceStats.currency = currency;

      // 4. AI analysis (optional)
      let ai: ShopAnalysisResult | null = null;
      if (useAi) {
        ai = await analyzeShop({
          shopName,
          site,
          total: score.total,
          scores: score.scores,
          issueSummary: {
            titleShortPct: score.issues.titleShort.pct,
            titleLongPct: score.issues.titleLong.pct,
            fewImagesPct: score.issues.fewImages.pct,
            noPricePct: score.issues.noPrice.pct,
            outOfStockPct: score.issues.outOfStock.pct,
            hasErrorPct: score.issues.hasError.pct,
          },
          niche: {
            categoryCount: score.niche.categoryCount,
            topShare: score.niche.topShare,
            top3Share: score.niche.top3Share,
            chaotic: score.niche.chaotic,
            topCategories: score.niche.categories.slice(0, 10).map((c) => ({
              name: c.categoryName,
              nodePath: c.nodePath,
              count: c.count,
              percent: c.percent,
            })),
          },
          priceStats: score.priceStats,
        });
      }

      const payload = {
        shopId,
        shopName,
        site,
        fetchedAt: Date.now(),
        ...score,
        ai,
        aiAvailable: useAi,
      };
      scoreCache.set(cacheKey, { ts: Date.now(), data: payload });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi chấm điểm shop" });
    }
  });

  // ── SHEIN product hunt (RapidAPI) — săn sản phẩm win ──
  // Search theo keyword/ngách → chấm winScore → trả grid đã rank.
  const sheinCache = new Map<string, { ts: number; data: any }>();
  const SHEIN_TTL = 5 * 60_000;

  app.get("/admin/api/shein/search", async (req, res) => {
    try {
      const query = ((req.query.query as string) || "").trim();
      if (!query) return res.status(400).json({ error: "query required" });
      const page = Number(req.query.page ?? 1);
      const perPage = Math.min(60, Number(req.query.perPage ?? 40));
      const country = (req.query.country as string) || "us";

      const cacheKey = `search:${country}:${query}:${page}:${perPage}`;
      const cached = sheinCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < SHEIN_TTL) {
        return res.json({ ...cached.data, cached: true });
      }

      const result = await sheinSearch(query, { page, perPage, country });
      const ranked = rankByWin(result.products);
      const payload = { query, total: result.total, page, hasNext: result.hasNext, products: ranked, source: result.source };
      sheinCache.set(cacheKey, { ts: Date.now(), data: payload });
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi search SHEIN" });
    }
  });

  app.get("/admin/api/shein/best", async (req, res) => {
    try {
      const categoryId = ((req.query.categoryId as string) || "").trim();
      if (!categoryId) return res.status(400).json({ error: "categoryId required" });
      const page = Number(req.query.page ?? 1);
      const perPage = Math.min(40, Number(req.query.perPage ?? 20));
      const country = (req.query.country as string) || "us";

      const result = await sheinBestByCategory(categoryId, { page, perPage, country });
      const ranked = rankByWin(result.products);
      res.json({ categoryId, page, products: ranked });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi best-seller SHEIN" });
    }
  });

  app.get("/admin/api/shein/detail", async (req, res) => {
    try {
      const goodsId = ((req.query.goodsId as string) || "").trim();
      if (!goodsId) return res.status(400).json({ error: "goodsId required" });
      const goodsSn = (req.query.goodsSn as string) || undefined;
      const country = (req.query.country as string) || "US";
      const detail = await sheinGetDetail(goodsId, { goodsSn, country });
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi detail SHEIN" });
    }
  });

  // Tìm shop SHEIN tương tự / đối thủ cùng ngách
  app.get("/admin/api/shein/similar-stores", async (req, res) => {
    try {
      const raw = ((req.query.store as string) || "").trim();
      if (!raw) return res.status(400).json({ error: "store (storeCode hoặc URL) required" });
      // Parse store_code: hoặc query param trong URL, hoặc chuỗi số
      let storeCode = raw;
      const m = raw.match(/store_code=(\d+)/) || raw.match(/(\d{6,})/);
      if (m) storeCode = m[1];
      if (!/^\d+$/.test(storeCode)) {
        return res.status(400).json({ error: "Không nhận diện được storeCode từ input" });
      }
      const country = (req.query.country as string) || "us";

      const cacheKey = `similar:${country}:${storeCode}`;
      const cached = sheinCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < SHEIN_TTL) {
        return res.json({ ...cached.data, cached: true });
      }

      const result = await findSimilarStores(storeCode, { country });
      sheinCache.set(cacheKey, { ts: Date.now(), data: result });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi tìm shop tương tự" });
    }
  });

  // ── Win Research (P1): candidate hằng ngày + duyệt 1-click → queue ──
  let researchRunning = false;

  // Các ngày đã có snapshot research
  app.get("/admin/api/research/days", (_req, res) => {
    try {
      res.json({ days: researchStore.listDays(), today: researchToday() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc days" });
    }
  });

  // Nhiệt ngách của 1 ngày
  app.get("/admin/api/research/niches", (req, res) => {
    try {
      const day = ((req.query.day as string) || researchStore.listDays()[0] || researchToday()).trim();
      res.json({ day, niches: researchStore.listNiches(day) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc niches" });
    }
  });

  // Danh sách candidate (mặc định ngày mới nhất, status=new)
  app.get("/admin/api/research/candidates", (req, res) => {
    try {
      const day = ((req.query.day as string) || researchStore.listDays()[0] || researchToday()).trim();
      const status = (req.query.status as any) || undefined;
      const limit = Math.min(200, Number(req.query.limit ?? 100));
      const offset = Number(req.query.offset ?? 0);
      const { items, total } = researchStore.listCandidates({ day, status, limit, offset });
      res.json({ day, total, candidates: items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc candidates" });
    }
  });

  // Chạy 1 vòng research (async — trả ngay, tiến độ qua live log SSE)
  app.post("/admin/api/research/run", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được chạy research" });
    if (researchRunning) return res.status(409).json({ error: "Research đang chạy, chờ xong đã" });
    researchRunning = true;
    res.json({ ok: true, started: true });
    runDailyResearch({ onLog: (m) => console.log("[research]", m) })
      .catch((e) => console.error("[research] lỗi:", e?.message ?? e))
      .finally(() => { researchRunning = false; });
  });

  // AI briefing (Gemini) cho ngày — phân tích + ghi ai_reason cho candidate (async)
  let aiRunning = false;
  app.post("/admin/api/research/ai", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    if (aiRunning) return res.status(409).json({ error: "AI đang chạy, chờ xong đã" });
    const day = ((req.body?.day as string) || "").trim() || undefined;
    aiRunning = true;
    res.json({ ok: true, started: true });
    generateResearchBriefing({ day, onLog: (m) => console.log("[research-ai]", m) })
      .catch((e) => console.error("[research-ai] lỗi:", e?.message ?? e))
      .finally(() => { aiRunning = false; });
  });

  app.get("/admin/api/research/briefing", (req, res) => {
    try {
      const day = ((req.query.day as string) || researchStore.listDays()[0] || researchToday()).trim();
      res.json({ day, briefing: researchStore.getBriefing(day) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc briefing" });
    }
  });

  // Deep Validation Gate: mở detail Kiki → sold/rank + local + true-to-size + verdict (async)
  let validateRunning = false;
  app.post("/admin/api/research/validate", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    if (validateRunning) return res.status(409).json({ error: "Validate đang chạy, chờ xong đã" });
    const profileId = ((req.body?.profileId as string) || "").trim();
    if (!profileId) return res.status(400).json({ error: "Thiếu Kiki profileId" });
    const day = ((req.body?.day as string) || "").trim() || undefined;
    const limit = Math.min(40, Number(req.body?.limit ?? 20));
    validateRunning = true;
    res.json({ ok: true, started: true, limit });
    validateCandidates({ profileId, day, limit, onLog: (m) => console.log("[validate]", m) })
      .catch((e) => console.error("[validate] lỗi:", e?.message ?? e))
      .finally(() => { validateRunning = false; });
  });

  // Làm giàu sold thật + rank cho top candidate bằng Kiki (async)
  let enrichRunning = false;
  app.post("/admin/api/research/enrich", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    if (enrichRunning) return res.status(409).json({ error: "Enrich đang chạy, chờ xong đã" });
    const profileId = ((req.body?.profileId as string) || "").trim();
    if (!profileId) return res.status(400).json({ error: "Thiếu Kiki profileId" });
    const day = ((req.body?.day as string) || "").trim() || undefined;
    const limit = Math.min(40, Number(req.body?.limit ?? 20));
    enrichRunning = true;
    res.json({ ok: true, started: true, limit });
    enrichCandidates({ profileId, day, limit, onLog: (m) => console.log("[enrich]", m) })
      .catch((e) => console.error("[enrich] lỗi:", e?.message ?? e))
      .finally(() => { enrichRunning = false; });
  });

  // Bỏ qua 1 candidate
  app.post("/admin/api/research/candidates/:id/dismiss", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    const c = researchStore.updateCandidate(req.params.id, { status: "dismissed" });
    if (!c) return res.status(404).json({ error: "Không tìm thấy candidate" });
    res.json({ ok: true, candidate: c });
  });

  // Duyệt 1-click: cào sp bằng Kiki → đẩy vào shop → status=queued
  app.post("/admin/api/research/candidates/:id/queue", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được đăng" });

      const cand = researchStore.findCandidate(req.params.id);
      if (!cand) return res.status(404).json({ error: "Không tìm thấy candidate" });
      if (!cand.url) return res.status(400).json({ error: "Candidate thiếu URL sản phẩm" });

      const body = req.body as { shop?: string; profileId?: string; options?: { divide4?: boolean; maxColors?: number } };
      const shop = (body.shop ?? "").trim();
      const profileId = (body.profileId ?? "").trim();
      if (!shop) return res.status(400).json({ error: "Phải chọn shop đích" });
      if (!profileId) return res.status(400).json({ error: "Thiếu Kiki profileId" });

      const { getUserDirsByName } = await import("./state/userDirs");
      const dirs = await getUserDirsByName(sessionUser.username);
      if (!dirs?.baseSheinAutoDir) return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });

      // Validate shop thuộc quyền user
      const adminCfg = await loadAdminConfig();
      const fullUser = adminCfg.users.find((u) => u.username === sessionUser.username);
      if ((fullUser?.profiles ?? []).length > 0 && !fullUser!.profiles.includes(shop)) {
        return res.status(403).json({ error: `Không có quyền shop: ${shop}` });
      }

      const logs: string[] = [];
      const data = await scrapeViaKiki({
        url: cand.url,
        profileId,
        options: body.options,
        onLog: (m) => { logs.push(m); console.log("[research:queue]", m); },
      });
      const written = await dispatchScrapedData(dirs.baseSheinAutoDir, data, [shop]);
      const updated = researchStore.updateCandidate(cand.id, { status: "queued", targetShop: shop });
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, candidate: updated, queued: written, product_name: data.product_name, logs });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đẩy candidate vào queue" });
    }
  });

  // ── Kiki scraper (trình duyệt thật, tránh captcha) ──────
  // GET profiles + trạng thái Kiki API
  app.get("/admin/api/kiki/profiles", async (_req, res) => {
    try {
      const cfg = readKikiConfig();
      const alive = await kiki.ping();
      res.json({ apiBase: cfg.apiBase, profiles: cfg.profiles, kikiAlive: alive });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc Kiki profiles" });
    }
  });

  // POST: lưu danh sách profiles (admin)
  app.post("/admin/api/kiki/profiles", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin" });
      const profiles = (req.body?.profiles ?? []) as { id: string; name: string }[];
      if (!Array.isArray(profiles)) return res.status(400).json({ error: "profiles phải là array" });
      const clean = profiles
        .filter((p) => p && typeof p.id === "string" && p.id.trim())
        .map((p) => ({ id: p.id.trim(), name: (p.name || p.id).trim() }));
      await saveKikiProfiles(clean);
      res.json({ ok: true, profiles: clean });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu profiles" });
    }
  });

  // POST scrape: cào 1..N url SHEIN bằng 1 Kiki profile → đẩy vào shops
  app.post("/admin/api/kiki/scrape", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được cào" });

      const body = req.body as {
        urls?: string[];
        shops?: string[];
        profileId?: string;
        options?: { divide4?: boolean; maxColors?: number };
      };
      const urls = (body.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
      const shops = (body.shops ?? []).filter(Boolean);
      const profileId = (body.profileId ?? "").trim();
      if (!profileId) return res.status(400).json({ error: "Thiếu profileId" });
      if (urls.length === 0) return res.status(400).json({ error: "Thiếu urls" });
      if (shops.length === 0) return res.status(400).json({ error: "Phải chọn ít nhất 1 shop" });
      if (urls.length > 20) return res.status(400).json({ error: "Tối đa 20 URL / lần" });

      const { getUserDirsByName } = await import("./state/userDirs");
      const dirs = await getUserDirsByName(sessionUser.username);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });
      }
      // Validate shops thuộc quyền user
      const adminCfg = await loadAdminConfig();
      const fullUser = adminCfg.users.find((u) => u.username === sessionUser.username);
      if ((fullUser?.profiles ?? []).length > 0) {
        const allowed = new Set(fullUser!.profiles);
        const invalid = shops.filter((s) => !allowed.has(s));
        if (invalid.length > 0) return res.status(403).json({ error: `Không có quyền shops: ${invalid.join(", ")}` });
      }

      // Xử lý tuần tự (1 profile không chạy song song được)
      const results: any[] = [];
      for (const url of urls) {
        const logs: string[] = [];
        try {
          const data = await scrapeViaKiki({
            url,
            profileId,
            options: body.options,
            onLog: (m) => logs.push(m),
          });
          const written = await dispatchScrapedData(dirs.baseSheinAutoDir, data, shops);
          results.push({
            url,
            ok: true,
            product_name: data.product_name,
            colors: data.listing_variations.colors.length,
            images: data.product_images.length,
            oosColors: data._meta?.oosColors ?? [],
            sold: data.stats?.soldText ?? null,
            reviewCount: data.stats?.reviewCount ?? null,
            rating: data.stats?.rating ?? null,
            queued: written,
            logs,
          });
        } catch (err: any) {
          results.push({ url, ok: false, error: err?.message ?? "lỗi", logs });
        }
      }
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi Kiki scrape" });
    }
  });

  // POST crawl-store: cào danh sách sản phẩm của nguyên 1 store SHEIN bằng Kiki
  app.post("/admin/api/kiki/crawl-store", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được cào" });

      const body = req.body as { store?: string; profileId?: string; maxProducts?: number; country?: string };
      const store = (body.store ?? "").trim();
      const profileId = (body.profileId ?? "").trim();
      if (!store) return res.status(400).json({ error: "Thiếu store (code hoặc URL)" });
      if (!profileId) return res.status(400).json({ error: "Thiếu profileId" });
      const maxProducts = Math.min(2000, Number(body.maxProducts ?? 300));

      const logs: string[] = [];
      const result = await crawlStoreViaKiki({
        store,
        profileId,
        maxProducts,
        country: body.country || "us",
        onLog: (m) => logs.push(m),
      });

      // Chấm winScore để thống kê listing nào "ok" (rating + review + giảm giá)
      const products = result.products
        .map((p) => {
          const w = scoreWin({
            goodsId: p.goodsId,
            goodsSn: p.goodsSn ?? "",
            name: p.name ?? "",
            image: p.image ?? "",
            url: p.url,
            price: p.price,
            retailPrice: p.retailPrice,
            discountPct: p.discountPct,
            commentNum: p.reviewCount,
            rating: p.rating,
            labels: [],
            source: "shein-data-api",
          });
          return { ...p, winScore: w.winScore, winTier: w.winTier };
        })
        .sort((a, b) => b.winScore - a.winScore);

      res.json({
        ok: true,
        storeCode: result.storeCode,
        storeUrl: result.storeUrl,
        quantity: result.quantity,
        count: products.length,
        products,
        logs,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi crawl store" });
    }
  });

  // ── Cookie 4Seller (per-user) ─────────────────────────
  // GET: cho UI biết user hiện tại đã upload cookie chưa
  app.get("/admin/api/cookie/status", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const file = userCookiePath(sessionUser.username);
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
        username: sessionUser.username,
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

      const body = req.body as { cookie: any[] };
      if (!Array.isArray(body.cookie)) {
        return res.status(400).json({ error: "Body phải có field 'cookie' là array" });
      }
      // Mỗi user lưu vào file riêng — không ghi đè user khác
      const targetFile = userCookiePath(sessionUser.username);
      await fs.ensureDir(path.dirname(targetFile));
      await fs.writeFile(targetFile, JSON.stringify(body.cookie, null, 2), "utf-8");
      res.json({ ok: true, count: body.cookie.length, savedTo: targetFile });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu cookie" });
    }
  });

  app.post("/admin/api/cookie/test", async (req, res) => {
    let browser: any = null;
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      // Test cookie của user đang đăng nhập (fallback global nếu chưa upload riêng)
      const cookie = await configCookie(sessionUser.username);
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
      res.json({ ok, finalUrl, status: resp?.status() ?? null, source: sessionUser.username });
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
