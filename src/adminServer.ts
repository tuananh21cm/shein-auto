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
import { scanListings, scanShopsSummary, resolveListingPath, scanHub, resolveHubFile, recordHubListings, removeHubMeta, isHubMetaFile, ListingStatus } from "./state/listingScan";
import { validatePath, detectDirConflicts, getUserDirsByName, getShopOwner } from "./state/userDirs";
import { processFile } from "./queue/queueManager";
import { eventBus } from "./state/eventBus";
import { workerConfig, reloadAppConfig } from "./config/appConfig";
import { configCookie, configCookieForAccount, userCookiePath } from "./utils/configCookie";
import {
  listAccounts as fsAccounts,
  saveAccountCookie,
  refreshAccountShops,
  setAccountLabel,
  deleteAccount as fsDeleteAccount,
  bootstrapLegacyCookies,
} from "./state/fourSellerAccounts";
import {
  getShopList as fsGetShopList,
  getStatusCount as fsGetStatusCount,
  getListingPage as fsGetListingPage,
  getSalesByShop as fsGetSalesByShop,
} from "./services/fourseller/client";

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
  // Ảnh preview tính năng listing (Settings → card shop) — sau requireAuth nên cần login
  app.use("/admin/previews", express.static(path.join(__dirname, "public", "previews")));

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

  // ── 4Seller helpers (port từ main): shop list / live / đơn / ảnh — cache chống spam API ──
  const shopListCache = new Map<string, { ts: number; shops: string[]; source: string }>();
  const SHOP_CACHE_TTL = 5 * 60_000;

  /**
   * Danh sách principal để gọi 4Seller API: mỗi TÀI KHOẢN 4Seller đã upload là 1
   * principal "acct:<uid>". Chưa setup tài khoản nào → fallback legacy cookie của
   * user truyền vào (chuyển đổi mượt).
   */
  const fsPrincipals = async (legacyUser?: string): Promise<string[]> => {
    const accounts = await fsAccounts();
    if (accounts.length > 0) return accounts.map((a) => `acct:${a.uid}`);
    return legacyUser ? [legacyUser] : [];
  };

  // Cache số listing LIVE (active) thật từ 4Seller — gộp MỌI tài khoản. Key cache cố định.
  const liveCountCache = new Map<string, { ts: number; byShop: Record<string, number> }>();
  /** Map shopName(lowercase) → activeCount thật trên TikTok (qua 4Seller). Best-effort, cache 5p. */
  async function fetchLiveCounts(username: string): Promise<Record<string, number>> {
    const cached = liveCountCache.get("__all__");
    if (cached && Date.now() - cached.ts < SHOP_CACHE_TTL) return cached.byShop;
    const byShop: Record<string, number> = {};
    for (const principal of await fsPrincipals(username)) {
      try {
        const list = await fsGetShopList(principal);
        const records = (list?.records ?? []).filter((s) => !s.platform || /tiktok/i.test(String(s.platform)));
        await Promise.all(
          records.map(async (s) => {
            try {
              const sc = await fsGetStatusCount(principal, { shopId: s.id });
              byShop[String(s.shopName).toLowerCase()] = sc?.activeCount ?? 0;
            } catch { /* 1 shop lỗi → bỏ qua */ }
          })
        );
      } catch { /* 1 tài khoản lỗi cookie → bỏ qua, tài khoản khác vẫn lấy được */ }
    }
    liveCountCache.set("__all__", { ts: Date.now(), byShop });
    return byShop;
  }

  // Ảnh ĐẠI DIỆN theo shop = ảnh 1 listing active (mainImage[0]). Cache DÀI 30p (ảnh ít đổi).
  const SHOP_IMG_TTL = 30 * 60_000;
  const shopImgCache = new Map<string, { ts: number; byShop: Record<string, string> }>();
  async function fetchShopImages(username: string): Promise<Record<string, string>> {
    const cached = shopImgCache.get("__all__");
    if (cached && Date.now() - cached.ts < SHOP_IMG_TTL) return cached.byShop;
    const byShop: Record<string, string> = {};
    for (const principal of await fsPrincipals(username)) {
      try {
        const list = await fsGetShopList(principal);
        const records = (list?.records ?? []).filter((s) => !s.platform || /tiktok/i.test(String(s.platform)));
        await Promise.all(
          records.map(async (s) => {
            try {
              const page = await fsGetListingPage(principal, { shopId: s.id, status: "active", pageSize: 1 });
              const rec = (page?.records ?? [])[0] as any;
              const img = rec?.mainImage ? String(rec.mainImage).split("|")[0].trim() : "";
              if (img) byShop[String(s.shopName).toLowerCase()] = img;
            } catch { /* 1 shop lỗi → bỏ qua */ }
          })
        );
      } catch { /* 1 tài khoản lỗi → bỏ qua */ }
    }
    shopImgCache.set("__all__", { ts: Date.now(), byShop });
    return byShop;
  }

  // Cache số ĐƠN theo shop (4Seller Report → Sales by shop), cửa sổ 7 ngày, gộp mọi tài khoản.
  const ordersCache = new Map<string, { ts: number; byShop: Record<string, number> }>();
  /** Map shopName(lowercase) → totalOrders 7 ngày gần nhất. Shop không có đơn → không có key (=0). */
  async function fetchOrdersByShop(username: string): Promise<Record<string, number>> {
    const cached = ordersCache.get("__all__");
    if (cached && Date.now() - cached.ts < SHOP_CACHE_TTL) return cached.byShop;
    const byShop: Record<string, number> = {};
    for (const principal of await fsPrincipals(username)) {
      try {
        const list = await fsGetShopList(principal);
        const ids = (list?.records ?? []).map((s) => s.id).filter((x) => x != null);
        if (!ids.length) continue;
        const vnDay = (off: number) =>
          new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - off * 864e5));
        const rows = await fsGetSalesByShop(principal, { startTime: vnDay(6), endTime: vnDay(0), shopIds: ids });
        for (const r of rows ?? []) {
          if (r?.shopName) byShop[String(r.shopName).toLowerCase()] = r.totalOrders ?? 0;
        }
      } catch { /* 1 tài khoản lỗi → bỏ qua */ }
    }
    ordersCache.set("__all__", { ts: Date.now(), byShop });
    return byShop;
  }

  /** Nguồn shop: ưu tiên SYNC TỪ 4SELLER (gộp mọi tài khoản) → profiles explicit → auto-scan folder. */
  async function resolveUserShops(user: AdminUser): Promise<{ shops: string[]; source: string }> {
    const cached = shopListCache.get(user.username);
    if (cached && Date.now() - cached.ts < SHOP_CACHE_TTL) return cached;
    try {
      const merged = new Set<string>();
      for (const principal of await fsPrincipals(user.username)) {
        try {
          const list = await fsGetShopList(principal);
          const records = list?.records ?? [];
          let shops = records
            .filter((s) => !s.platform || /tiktok/i.test(String(s.platform)))
            .map((s) => s.shopName)
            .filter(Boolean);
          if (shops.length === 0) shops = records.map((s) => s.shopName).filter(Boolean);
          shops.forEach((s) => merged.add(s));
        } catch { /* 1 tài khoản lỗi → vẫn lấy tài khoản khác */ }
      }
      if (merged.size > 0) {
        const shops = Array.from(merged).sort();
        const out = { ts: Date.now(), shops, source: "4seller" };
        shopListCache.set(user.username, out);
        return out;
      }
    } catch (e: any) {
      console.warn(`[shops] 4Seller getShopList lỗi (fallback folder): ${e?.message ?? e}`);
    }
    if ((user.profiles ?? []).length > 0) {
      return { ts: Date.now(), shops: user.profiles, source: "explicit" } as any;
    }
    try {
      const dirs = await getUserDirsByName(user.username);
      if (dirs?.baseSheinAutoDir && (await fs.pathExists(dirs.baseSheinAutoDir))) {
        const entries = await fs.readdir(dirs.baseSheinAutoDir);
        const shops: string[] = [];
        for (const name of entries) {
          if (name.startsWith(".") || name === "Success" || name === "Fail") continue;
          const stats = await fs.stat(path.join(dirs.baseSheinAutoDir, name)).catch(() => null);
          if (stats?.isDirectory()) shops.push(name);
        }
        shops.sort();
        return { ts: Date.now(), shops, source: "auto-scan" } as any;
      }
    } catch { /* ignore */ }
    return { ts: Date.now(), shops: [], source: "empty" } as any;
  }

  // ── Dashboard ─────────────────────────────────────────────
  app.get("/admin/api/dashboard", async (req, res) => {
    try {
      const queue = await refreshQueueSnapshot();
      // Allowlist shop (4Seller hiện tại) để UI tự ẩn folder "lạ" rỗng — KHÔNG xoá data.
      let shops: { list: string[]; source: string } = { list: [], source: "empty" };
      try {
        const sessionUser = (req.session as any).user as SessionUser | undefined;
        if (sessionUser) {
          const cfg = await loadAdminConfig();
          const u = cfg.users.find((x) => x.username === sessionUser.username);
          if (u) {
            const r = await resolveUserShops(u as any);
            shops = { list: r.shops, source: r.source };
          }
        }
      } catch { /* allowlist best-effort */ }
      res.json({
        worker: workerState.get(),
        queue,
        shops,
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

  // ── Dashboard OVERVIEW (port từ main): live/đơn/doanh thu + Δ hôm qua, promotion, sparkline ──
  const dayOrdersCache = new Map<string, { ts: number; byShop: Record<string, { orders: number; revenue: number }> }>();
  /** Đơn + doanh thu của 1 NGÀY (YYYY-MM-DD) per shop, gộp mọi tài khoản. Cache 5p. */
  async function fetchDaySales(day: string, legacyUser: string): Promise<Record<string, { orders: number; revenue: number }>> {
    const cached = dayOrdersCache.get(day);
    if (cached && Date.now() - cached.ts < SHOP_CACHE_TTL) return cached.byShop;
    const byShop: Record<string, { orders: number; revenue: number }> = {};
    for (const principal of await fsPrincipals(legacyUser)) {
      try {
        const list = await fsGetShopList(principal);
        const ids = (list?.records ?? []).map((s) => s.id).filter((x) => x != null);
        if (!ids.length) continue;
        const rows = await fsGetSalesByShop(principal, { startTime: day, endTime: day, shopIds: ids });
        for (const r of rows ?? []) {
          if (r?.shopName) {
            byShop[String(r.shopName).toLowerCase()] = {
              orders: r.totalOrders ?? 0,
              revenue: r.totalSales ?? 0,
            };
          }
        }
      } catch { /* 1 tài khoản lỗi → bỏ qua */ }
    }
    dayOrdersCache.set(day, { ts: Date.now(), byShop });
    return byShop;
  }

  // ── Sales trend 30 ngày (clone chart 4Seller): daily revenue+orders GỘP mọi shop/account ──
  // Nguồn = 4Seller getSalesByShop per-day (dashboard_snapshot cũ thưa/không đủ). Persist vào
  // sales_daily: ngày quá khứ bất biến → fetch 1 lần; chỉ 3 ngày gần refetch (đơn còn settle).
  app.get("/admin/api/dashboard/sales-trend", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const { getDb } = await import("./state/db");
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS sales_daily (day TEXT PRIMARY KEY, orders INTEGER, revenue REAL, updated_at INTEGER)`);
      const vnDay = (o = 0) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - o * 864e5));
      const N = Math.min(60, Math.max(7, Number(req.query.days) || 30));
      const days = Array.from({ length: N }, (_, i) => vnDay(N - 1 - i)); // cũ → mới
      const recent = new Set([vnDay(0), vnDay(1), vnDay(2)]); // refetch: đơn còn settle
      const stored = new Map<string, { orders: number; revenue: number }>();
      for (const r of db.prepare(`SELECT day, orders, revenue FROM sales_daily WHERE day >= ?`).all(days[0]) as any[])
        stored.set(r.day, { orders: r.orders, revenue: r.revenue });
      const upsert = db.prepare(
        `INSERT INTO sales_daily(day, orders, revenue, updated_at) VALUES(?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET orders=excluded.orders, revenue=excluded.revenue, updated_at=excluded.updated_at`
      );
      const out: { date: string; revenue: number; orders: number }[] = [];
      for (const day of days) {
        let rec = stored.get(day);
        if (!rec || recent.has(day)) {
          const byShop = await fetchDaySales(day, sessionUser.username);
          let orders = 0, revenue = 0;
          for (const v of Object.values(byShop)) { orders += v.orders || 0; revenue += v.revenue || 0; }
          rec = { orders, revenue: Math.round(revenue * 100) / 100 };
          upsert.run(day, rec.orders, rec.revenue, Date.now());
        }
        out.push({ date: day, revenue: rec.revenue, orders: rec.orders });
      }
      res.json({
        ok: true,
        days: out,
        totalRevenue: Math.round(out.reduce((s, x) => s + x.revenue, 0) * 100) / 100,
        totalOrders: out.reduce((s, x) => s + x.orders, 0),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi sales-trend" });
    }
  });

  app.get("/admin/api/dashboard/overview", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const { getDb } = await import("./state/db");
      const db = getDb();
      db.exec(
        `CREATE TABLE IF NOT EXISTS dashboard_snapshot (
           day TEXT NOT NULL, shop TEXT NOT NULL, live INTEGER, orders REAL, revenue REAL,
           PRIMARY KEY (day, shop))`
      );

      // Mốc ngày theo GIỜ VN — 4Seller gom theo ngày US nên sáng VN "hôm nay" có thể ~0.
      const vnDay = (offsetDays = 0) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
          new Date(Date.now() - offsetDays * 864e5)
        );
      const today = vnDay(0);
      const yesterday = vnDay(1);

      const [diskShops, liveByShop, salesToday, salesYesterday, orders7d, imgByShop] = await Promise.all([
        scanShopsSummary({ username: ownerScope(req) }),
        fetchLiveCounts(sessionUser.username),
        fetchDaySales(today, sessionUser.username),
        fetchDaySales(yesterday, sessionUser.username),
        fetchOrdersByShop(sessionUser.username),
        fetchShopImages(sessionUser.username),
      ]);

      // Health (shop_analysis, tiktok.db) — best-effort
      const healthByShop = new Map<string, any>();
      try {
        const { TiktokDb } = await import("./services/tiktok/db");
        const tdb = new TiktokDb();
        try {
          for (const a of tdb.listShopAnalysis()) {
            healthByShop.set(String(a.shop).toLowerCase(), {
              overall: a.overall ?? null,
              alerts: (() => { try { return JSON.parse(a.alerts_json).length; } catch { return 0; } })(),
            });
          }
        } finally { tdb.close(); }
      } catch { /* chưa có phân tích */ }

      // Promotion (scan gần nhất — cron mỗi 2 giờ tự cào)
      const { getLastPromoScan } = await import("./core/promotionScan");
      const promo = await getLastPromoScan();
      const promoByShop = new Map<string, { flashExpired: boolean; uncovered: number | null; noDiscount: boolean }>();
      for (const r of promo?.rows ?? []) {
        promoByShop.set(r.shop.toLowerCase(), {
          flashExpired: r.flashExpired,
          uncovered: r.uncoveredProducts,
          noDiscount: r.discountOngoing === 0,
        });
      }

      // Danh sách shop: ưu tiên shop 4Seller thật; folder đĩa để lấy pending/fail
      const diskByName = new Map(diskShops.map((s) => [s.folder.toLowerCase(), s]));
      const cfg = await loadAdminConfig();
      const u = cfg.users.find((x) => x.username === sessionUser.username);
      const shopSource = u ? await resolveUserShops(u as any) : { shops: [] as string[], source: "empty" };
      const shopNames = shopSource.shops.length ? shopSource.shops : diskShops.map((s) => s.folder);

      const upsert = db.prepare(
        `INSERT INTO dashboard_snapshot (day, shop, live, orders, revenue) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, shop) DO UPDATE SET live=excluded.live, orders=excluded.orders, revenue=excluded.revenue`
      );
      const getSnap = db.prepare("SELECT live FROM dashboard_snapshot WHERE day=? AND shop=?");

      // Series 7 ngày (orders/revenue) cho SPARKLINE mỗi shop — 1 query, map theo shop.
      const days7 = [6, 5, 4, 3, 2, 1, 0].map((d) => vnDay(d)); // cũ → mới (hôm nay cuối)
      const snap7 = db.prepare(
        `SELECT shop, day, orders, revenue FROM dashboard_snapshot WHERE day >= ?`
      ).all(days7[0]) as any[];
      const seriesByShop = new Map<string, Map<string, { o: number; r: number }>>();
      for (const s of snap7) {
        const lc = String(s.shop).toLowerCase();
        if (!seriesByShop.has(lc)) seriesByShop.set(lc, new Map());
        seriesByShop.get(lc)!.set(s.day, { o: s.orders ?? 0, r: s.revenue ?? 0 });
      }

      const accounts = await fsAccounts().catch(() => []);
      const normShop = (x: string) => (x || "").toLowerCase().replace(/[\s—–-]+/g, "");
      const accountByShop = new Map<string, string>();
      for (const a of accounts) for (const s of a.shops) accountByShop.set(normShop(s), a.label);

      const rows = shopNames.map((name) => {
        const lc = name.toLowerCase();
        const disk = diskByName.get(lc);
        const live = lc in liveByShop ? liveByShop[lc] : null;
        const st = salesToday[lc] ?? { orders: 0, revenue: 0 };
        const sy = salesYesterday[lc] ?? { orders: 0, revenue: 0 };
        const liveYesterday = (getSnap.get(yesterday, name) as any)?.live ?? null;
        if (live != null) upsert.run(today, name, live, st.orders, st.revenue);
        const pr = promoByShop.get(lc);
        const ser = seriesByShop.get(lc);
        const sparkOrders = days7.map((d, i) => (i === days7.length - 1 ? st.orders : ser?.get(d)?.o ?? 0));
        return {
          shop: name,
          account: accountByShop.get(normShop(name)) ?? null,
          image: imgByShop[lc] ?? null,
          live,
          liveYesterday,
          ordersToday: st.orders,
          ordersYesterday: sy.orders,
          revenueToday: st.revenue,
          revenueYesterday: sy.revenue,
          orders7d: orders7d[lc] ?? 0,
          sparkOrders,
          health: healthByShop.get(lc) ?? null,
          flashExpired: pr?.flashExpired ?? null,
          uncovered: pr?.uncovered ?? null,
          noDiscount: pr?.noDiscount ?? null,
          pending: disk?.pending ?? 0,
          fail: disk?.fail ?? 0,
        };
      });

      res.json({
        ok: true,
        today,
        yesterday,
        promoScannedAt: promo?.scannedAt ?? null,
        worker: workerState.get(),
        rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi dashboard overview" });
    }
  });

  // ── Promotion scan (Marketing → Product Discount / Flash Deal) — port từ main ──
  app.get("/admin/api/promotions", async (_req, res) => {
    const { getLastPromoScan, isPromoScanRunning } = await import("./core/promotionScan");
    res.json({ ok: true, running: isPromoScanRunning(), result: await getLastPromoScan() });
  });

  app.post("/admin/api/promotions/scan", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể scan" });
      const sync = req.body?.sync !== false; // mặc định CÓ sync (data mới mỗi lần cào)
      const { runAndStorePromoScan } = await import("./core/promotionScan");
      const result = await runAndStorePromoScan({ sync, onLog: (m) => console.log("[promo]", m) });
      res.json({ ok: true, result });
    } catch (err: any) {
      const busy = /Đang scan/.test(err?.message ?? "");
      res.status(busy ? 409 : 500).json({ error: err?.message ?? "Lỗi scan promotion" });
    }
  });

  // ── Cấu hình listing THEO SHOP (config/shop-listing.json) ──
  // { "<shopFolder>": { colorShowcase?, richDesc?, bannerCollage?, bannerFeature?, sizeGuide?: boolean } }
  // Thiếu key / thiếu shop = BẬT (giữ hành vi cũ). Worker đọc file TƯƠI mỗi listing → sửa là ăn ngay.
  const SHOP_LISTING_FILE = path.join(process.cwd(), "config", "shop-listing.json");
  const readShopListing = (): Record<string, any> => {
    try { return JSON.parse(fs.readFileSync(SHOP_LISTING_FILE, "utf-8")); } catch { return {}; }
  };
  app.get("/admin/api/shop-listing", (_req, res) => {
    res.json({ prefs: readShopListing() });
  });
  app.post("/admin/api/shop-listing", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể sửa" });
      const { shop, prefs } = req.body as { shop?: string; prefs?: Record<string, any> };
      if (!shop) return res.status(400).json({ error: "Thiếu shop" });
      const all = readShopListing();
      // Chỉ giữ key false (tắt) — bật là mặc định, khỏi phình file
      const clean: Record<string, boolean> = {};
      for (const k of ["colorShowcase", "richDesc", "bannerCollage", "bannerFeature", "sizeGuide", "variantToMain"]) {
        if (prefs?.[k] === false) clean[k] = false;
      }
      if (Object.keys(clean).length === 0) delete all[shop];
      else all[shop] = clean;
      await fs.writeFile(SHOP_LISTING_FILE, JSON.stringify(all, null, 2), "utf-8");
      res.json({ ok: true, prefs: all });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu shop-listing" });
    }
  });

  // ── Pool imgbb: thống kê usage/rate-limit từng key + test sống ──
  app.get("/admin/api/imgbb/status", async (_req, res) => {
    try {
      const { getImgbbStats } = await import("./utils/uploadToImgbb");
      const s = getImgbbStats();
      const hourNow = new Date().toISOString().slice(0, 13);
      const keys = config.imgbbApiKeys.map((k, i) => {
        const id = k.slice(-6);
        const ks = s.keys[id];
        const cur = ks?.hours?.[hourNow] ?? { ok: 0, limit: 0 };
        // 24 bucket giờ gần nhất cho sparkline
        const hours: { h: string; ok: number; limit: number }[] = [];
        for (let off = 23; off >= 0; off--) {
          const h = new Date(Date.now() - off * 3600e3).toISOString().slice(0, 13);
          const b = ks?.hours?.[h] ?? { ok: 0, limit: 0 };
          hours.push({ h: h.slice(11) + "h", ok: b.ok, limit: b.limit });
        }
        return {
          index: i + 1,
          keyMasked: "…" + id,
          ok: ks?.ok ?? 0,
          ratelimit: ks?.ratelimit ?? 0,
          error: ks?.error ?? 0,
          lastOkAt: ks?.lastOkAt ?? null,
          lastLimitAt: ks?.lastLimitAt ?? null,
          hourOk: cur.ok,
          hourLimit: cur.limit,
          hours,
        };
      });
      res.json({
        ok: true, keys,
        gaveup: s.gaveup, lastGaveupAt: s.lastGaveupAt,
        verifyFail: s.verifyFail, lastVerifyFailAt: s.lastVerifyFailAt,
        // imgbb KHÔNG công bố quota — ngưỡng ước tính từ quan sát thực tế (06/08: nghẽn ~100 up/key/giờ)
        estHourlyLimitPerKey: 100,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi imgbb status" });
    }
  });

  // Test sống từng key: upload 1 ảnh 1px thật (tốn 1 lượt quota/key)
  app.post("/admin/api/imgbb/test", async (_req, res) => {
    try {
      const axios = (await import("axios")).default;
      // PNG 1x1 trắng
      const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const results = [];
      for (let i = 0; i < config.imgbbApiKeys.length; i++) {
        const key = config.imgbbApiKeys[i];
        try {
          const form = new URLSearchParams();
          form.append("image", px);
          const r = await axios.post(`https://api.imgbb.com/1/upload?key=${key}`, form, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000,
          });
          results.push({ index: i + 1, keyMasked: "…" + key.slice(-6), ok: !!r.data?.data?.url });
        } catch (e: any) {
          const msg = e?.response?.data?.error?.message || e?.message || "";
          results.push({ index: i + 1, keyMasked: "…" + key.slice(-6), ok: false, error: msg, ratelimited: /rate limit/i.test(msg) });
        }
      }
      res.json({ ok: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi test imgbb" });
    }
  });

  // Ảnh đại diện shop (1 listing active gần nhất, cache 30p) — cho card shop ở Settings
  app.get("/admin/api/shop-images", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      res.json({ byShop: await fetchShopImages(sessionUser.username) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lấy ảnh shop" });
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

  // Tiến độ đăng listing — TẤT CẢ shop 4Seller (target 100/shop). Live count từ 4Seller
  // (cache 5p) + merge pending/fail/today từ folder local (shop đã có hoạt động).
  app.get("/admin/api/listings/progress", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const [accounts, liveByShop, imgByShop] = await Promise.all([
        fsAccounts().catch(() => [] as any[]),
        fetchLiveCounts(sessionUser.username).catch(() => ({} as Record<string, number>)),
        fetchShopImages(sessionUser.username).catch(() => ({} as Record<string, string>)),
      ]);
      const localByShop = new Map<string, any>();
      try { for (const s of await scanShopsSummary({ username: ownerScope(req) })) localByShop.set(s.folder.toLowerCase(), s); } catch { /* ignore */ }
      const seen = new Set<string>();
      const shops: any[] = [];
      for (const acc of accounts) {
        for (const name of (acc.shops || [])) {
          const lc = String(name).toLowerCase();
          if (seen.has(lc)) continue;
          seen.add(lc);
          const loc = localByShop.get(lc) || {};
          shops.push({
            folder: name,
            owner: loc.owner || sessionUser.username,
            account: acc.label,
            live: lc in liveByShop ? liveByShop[lc] : null,
            image: loc.cover || imgByShop[lc] || null,
            pending: loc.pending || 0,
            fail: loc.fail || 0,
            success: loc.success || 0,
            todayCount: loc.todayCount || 0,
          });
        }
      }
      res.json({ shops, target: 100 });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi progress" });
    }
  });

  // ── Thống kê theo NGÁCH: ngách nào có shop nào chơi + sp crawl + điểm cơ hội ──
  // === NGÁCH: suy thẳng từ JSON (mỗi file có `category` breadcrumb → deriveNiche) ===
  // KHÔNG phụ thuộc crawler/SQLite — chạy trên mọi máy chỉ với data Hub + folder shop.
  //   • by-niche  : gom sp Hub (pool cả đội) theo ngách.
  //   • by-shop   : shop nào chơi ngách nào — TEAM-WIDE (xem helper).

  // Gom (shop → ngách) TEAM-WIDE: (a) folder shop máy mình từ scanListings (chi tiết
  // pending/success), + (b) listedShops trong sidecar Hub (chia sẻ qua HUB_DIR → shop
  // của cả đội, lớn dần mỗi lần ai list qua Hub). Shop đã có ở (a) thì bỏ ở (b) tránh đếm đúp.
  const collectShopNiche = async (
    req: express.Request
  ): Promise<{ byShop: Map<string, Map<string, { products: number; listed: number }>>; hub: Awaited<ReturnType<typeof scanHub>> }> => {
    const [listings, hub] = await Promise.all([scanListings({ username: ownerScope(req) }), scanHub()]);
    const byShop = new Map<string, Map<string, { products: number; listed: number }>>();
    const bump = (shop: string, niche: string, listed: boolean) => {
      let m = byShop.get(shop);
      if (!m) { m = new Map(); byShop.set(shop, m); }
      let e = m.get(niche);
      if (!e) { e = { products: 0, listed: 0 }; m.set(niche, e); }
      e.products++;
      if (listed) e.listed++;
    };
    for (const c of listings) if (c.niche) bump(c.folder, c.niche, c.status === "success");
    const localShops = new Set(byShop.keys());
    for (const h of hub) {
      if (!h.niche || !h.listedShops?.length) continue;
      for (const shop of h.listedShops) {
        if (localShops.has(shop)) continue; // shop máy mình → đã tính ở trên
        bump(shop, h.niche, true); // sidecar = đã list
      }
    }
    return { byShop, hub };
  };

  app.get("/admin/api/niche/overview", async (req, res) => {
    try {
      const { byShop, hub } = await collectShopNiche(req);
      // pool Hub theo ngách: số sp + 3 ảnh preview (team-wide, cả đội cào)
      const pool = new Map<string, { products: number; previews: string[] }>();
      for (const it of hub) {
        if (!it.niche) continue;
        let e = pool.get(it.niche);
        if (!e) { e = { products: 0, previews: [] }; pool.set(it.niche, e); }
        e.products++;
        if (it.image && e.previews.length < 3) e.previews.push(it.image);
      }
      // shop + số đã list theo ngách (team-wide, từ byShop)
      const perNiche = new Map<string, { listed: number; shops: Set<string> }>();
      for (const [shop, m] of byShop) {
        for (const [niche, e] of m) {
          let x = perNiche.get(niche);
          if (!x) { x = { listed: 0, shops: new Set() }; perNiche.set(niche, x); }
          x.listed += e.listed; x.shops.add(shop);
        }
      }
      const nicheSet = new Set<string>([...pool.keys(), ...perNiche.keys()]);
      const niches = [...nicheSet].map((niche) => {
        const p = pool.get(niche) || { products: 0, previews: [] };
        const l = perNiche.get(niche) || { listed: 0, shops: new Set<string>() };
        return {
          niche,
          shops: [...l.shops].map((shop) => ({ shop, status: null })),
          products: p.products, listed: l.listed,
          avgOpp: null, avgWin: null,
          previews: p.previews,
        };
      }).sort((a, b) => b.products - a.products);
      res.json({
        niches,
        totals: {
          niches: niches.length,
          shops: byShop.size,
          products: hub.filter((h) => h.niche).length,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi niche overview" });
    }
  });

  // Top sản phẩm 1 ngách — từ pool Hub, ưu tiên sp đã list rồi tới nhiều shop.
  app.get("/admin/api/niche/products", async (req, res) => {
    try {
      const niche = String(req.query.niche || "");
      if (!niche) return res.status(400).json({ error: "Thiếu niche" });
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
      const hub = await scanHub();
      const products = hub
        .filter((h) => h.niche === niche)
        .map((h) => ({
          goods_id: h.id,
          name: h.title,
          image: h.image,
          price: h.priceRange?.min ?? null,
          url: h.url ?? null,
          win: null, opp: null,
          shopCount: h.listedCount || 0,
          listed: (h.listedCount || 0) > 0 ? 1 : 0,
        }))
        .sort((a, b) => (b.listed - a.listed) || (b.shopCount - a.shopCount))
        .slice(0, limit);
      res.json({ niche, products });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi niche products" });
    }
  });

  // View THEO SHOP: mỗi shop chơi ngách nào — TEAM-WIDE (shop máy mình + shop đội qua Hub).
  app.get("/admin/api/niche/by-shop", async (req, res) => {
    try {
      const { byShop } = await collectShopNiche(req);
      const shops = [...byShop.entries()].map(([shop, m]) => {
        const niches = [...m.entries()]
          .map(([niche, e]) => ({ niche, products: e.products, listed: e.listed }))
          .sort((a, b) => b.products - a.products);
        return {
          shop,
          total: niches.reduce((s, n) => s + n.products, 0),
          niches,
          primary: niches[0]?.niche ?? null, // ngách nhiều sp nhất = chủ đạo
          status: null,
        };
      }).sort((a, b) => b.total - a.total);
      res.json({ shops, totalShops: shops.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi niche by-shop" });
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
      (f) => f.toLowerCase().endsWith(".json") && !isHubMetaFile(f)
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
  // addedBy = người cào (share đội): stamp vào file để hiện "ai cào" + lọc.
  const writeHubFile = async (data: any, addedBy?: string): Promise<string> => {
    await fs.ensureDir(config.hubDir);
    const fileName = `hub_${Date.now()}_${Math.floor(Math.random() * 1e6)}.json`;
    const withMeta = { ...data, _addedBy: addedBy || data?._addedBy || null, _addedAt: data?._addedAt || Date.now() };
    await fs.writeFile(path.join(config.hubDir, fileName), JSON.stringify(withMeta, null, 2), "utf-8");
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
      const addedBy = (req as any).tokenUser?.username;
      const file = await writeHubFile(data, addedBy);
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
        const file = await writeHubFile(data, sessionUser.username);
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
        await writeHubFile(data, sessionUser.username);
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

  // ── Cookie 4Seller (ĐA TÀI KHOẢN — auto-detect qua cookie `uid`) — port từ main ──
  // GET: danh sách tài khoản đã upload + shop của từng tài khoản
  app.get("/admin/api/cookie/status", async (_req, res) => {
    try {
      const accounts = await fsAccounts();
      res.json({
        accounts: accounts.map((a) => ({
          uid: a.uid,
          label: a.label,
          shops: a.shops,
          shopCount: a.shops.length,
          cookieCount: a.cookieCount,
          cookieUpdatedAt: a.cookieUpdatedAt,
          shopsUpdatedAt: a.shopsUpdatedAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc status cookie" });
    }
  });

  // POST: nhận 1 file cookie export (paste hoặc kéo-thả). Tự detect tài khoản qua cookie `uid`.
  app.post("/admin/api/cookie", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể upload cookie" });

      const body = req.body as { cookie: any };
      const { account, shopSyncError } = await saveAccountCookie(body.cookie);
      // Đổi cookie / thêm shop → xoá cache để UI phản ánh ngay
      shopListCache.clear();
      liveCountCache.clear();
      ordersCache.clear();
      res.json({
        ok: true,
        uid: account.uid,
        label: account.label,
        cookieCount: account.cookieCount,
        shopCount: account.shops.length,
        shopSyncError: shopSyncError ?? null,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Lỗi lưu cookie" });
    }
  });

  // Đổi nhãn tài khoản ("Tài khoản 1" → tên dễ nhớ)
  app.post("/admin/api/cookie/label", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể sửa" });
      const { uid, label } = req.body as { uid: string; label: string };
      await setAccountLabel(uid, label);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Lỗi đổi nhãn" });
    }
  });

  // Sync lại shop list của 1 tài khoản từ 4Seller
  app.post("/admin/api/cookie/refresh-shops", async (req, res) => {
    try {
      const { uid } = req.body as { uid: string };
      const shops = await refreshAccountShops(uid);
      shopListCache.clear();
      res.json({ ok: true, shopCount: shops.length, shops });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Lỗi sync shop" });
    }
  });

  // Xoá 1 tài khoản (cookie + registry)
  app.delete("/admin/api/cookie", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role !== "admin") return res.status(403).json({ error: "Chỉ admin xoá được tài khoản" });
      const { uid } = req.body as { uid: string };
      await fsDeleteAccount(uid);
      shopListCache.clear();
      liveCountCache.clear();
      ordersCache.clear();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Lỗi xoá tài khoản" });
    }
  });

  // Test cookie 1 tài khoản (mở page 4Seller headless xem có bị đá về login không)
  app.post("/admin/api/cookie/test", async (req, res) => {
    let browser: any = null;
    try {
      const { uid } = req.body as { uid?: string };
      let cookie: any[];
      let source: string;
      if (uid) {
        cookie = await configCookieForAccount(uid);
        source = `acct:${uid}`;
      } else {
        // Không truyền uid: test tài khoản đầu tiên (hoặc legacy user nếu chưa có tài khoản)
        const accounts = await fsAccounts();
        if (accounts.length > 0) {
          cookie = await configCookieForAccount(accounts[0].uid);
          source = `acct:${accounts[0].uid}`;
        } else {
          const sessionUser = (req.session as any).user as SessionUser;
          cookie = await configCookie(sessionUser.username);
          source = sessionUser.username;
        }
      }
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
      res.json({ ok, finalUrl, status: resp?.status() ?? null, source });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? "Lỗi test cookie" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // Ping NHẸ 1 tài khoản (1 HTTP getShopList, ~1s) — auto-check cookie sống/chết, KHÔNG mở browser.
  app.get("/admin/api/cookie/ping", async (req, res) => {
    try {
      const uid = String(req.query.uid || "");
      if (!uid) return res.status(400).json({ error: "Thiếu uid" });
      const list = await fsGetShopList(`acct:${uid}`);
      res.json({ alive: true, shops: (list?.records ?? []).length });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const expired = /login|validation|unauthor|401|403|expire/i.test(msg);
      res.json({ alive: false, expired, error: msg.slice(0, 140) });
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

  // Chuyển đổi mượt: import cookie legacy (data/cookies/<user>.json) vào registry
  // tài khoản 1 lần khi start (file có uid/userToken mới import được).
  bootstrapLegacyCookies().catch(() => {});

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
