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
import { runPodRouterOnce, ingestPodDesign } from "./queue/podRouter";
import { resolvePodMaterialDir } from "./core/pod/buildPodListing";
import { crawlImages } from "./core/imageCrawler/crawlImages";
import crypto from "crypto";
import { eventBus } from "./state/eventBus";
import { workerConfig, reloadAppConfig } from "./config/appConfig";
import { configCookie, configCookieForAccount, userCookiePath } from "./utils/configCookie";
import {
  listAccounts as fsAccounts,
  saveAccountCookie,
  refreshAccountShops,
  deleteAccount as fsDeleteAccount,
  setAccountLabel,
  resolveAccountForShop,
  bootstrapLegacyCookies,
} from "./state/fourSellerAccounts";
import {
  getShopList as fsGetShopList,
  getStatusCount as fsGetStatusCount,
  getListingPage as fsGetListingPage,
  getListingDetail as fsGetListingDetail,
  getCategoryById as fsGetCategoryById,
  getSalesByShop as fsGetSalesByShop,
  type FourSellerShop as FourSellerShopT,
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
import { runDemandCollection } from "./core/research/collectDemand";
import { isFashionCategory } from "./core/research/demandFit";
import { computeDropScores } from "./core/research/dropScore";
import { shopNicheStore, type ShopNicheStatus } from "./state/shopNicheStore";
import { kalodataStore } from "./state/kalodataStore";
import { researchStore, today as researchToday } from "./state/researchStore";
import { EditDb } from "./services/tiktok/editDb";

const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "shein-auto-secret";

type SessionUser = { username: string; role: "admin" | "editor" | "viewer" };

const sanitizeUserForUi = (user: AdminUser) => ({
  username: user.username,
  password: "",
  role: user.role,
  profiles: user.profiles,
  downloadDir: user.downloadDir ?? "",
  baseSheinAutoDir: user.baseSheinAutoDir ?? "",
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

  // Cache shop list 4Seller — extension poll /profiles mỗi 10s nên PHẢI
  // cache, tránh spam /api/shop/get-tidy-list (rate-limit/khoá cookie).
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
  // 4Seller không có sold theo sản phẩm → không rank được best-seller; lấy listing active gần nhất.
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
        // Mốc ngày theo giờ VN (đồng bộ với dashboard overview). 4Seller vẫn gom theo ngày US.
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

  /**
   * Nguồn shop cho Tampermonkey. Ưu tiên SYNC TỪ 4SELLER (getShopList) → tên shop
   * THẬT để khớp đúng dropdown lúc đăng (selectProfile match theo title). Fallback
   * theo thứ tự: user.profiles (explicit) → auto-scan folder → rỗng.
   */
  async function resolveUserShops(user: AdminUser): Promise<{ shops: string[]; source: string }> {
    const cached = shopListCache.get(user.username);
    if (cached && Date.now() - cached.ts < SHOP_CACHE_TTL) return cached;

    // 1. 4Seller — GỘP shop của MỌI tài khoản đã upload (đa tài khoản, mỗi tài khoản ~30 shop).
    //    Tên = shopName thật ("TA Scan152-Fashion Lace_US").
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
      console.warn(`[profiles] 4Seller getShopList lỗi (fallback folder): ${e?.message ?? e}`);
    }
    // 2. Explicit profiles
    if ((user.profiles ?? []).length > 0) {
      return { ts: Date.now(), shops: user.profiles, source: "explicit" } as any;
    }
    // 3. Auto-scan folder baseDir
    try {
      const { getUserDirsByName } = await import("./state/userDirs");
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
    } catch {
      /* ignore */
    }
    return { ts: Date.now(), shops: [], source: "empty" } as any;
  }

  ingestRouter.get("/profiles", ingestAuth, async (req, res) => {
    try {
      const user = (req as any).tokenUser as AdminUser;
      const { shops, source } = await resolveUserShops(user);
      res.json({ username: user.username, profiles: shops, source });
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
      // HARD GATE: extension cào hỏng (thiếu product_name/ảnh/màu) → TỪ CHỐI, KHÔNG ghi JSON
      // vào queue (tránh case "Title rỗng vì product_name undefined" lúc list). Cùng chuẩn với
      // path cào Chrome/Kiki. Extension nhận lỗi rõ → user cào lại sp đó.
      const { hardScrapeError } = await import("./core/scrapeViaKiki");
      const hard = hardScrapeError(data);
      if (hard) {
        console.warn(`⚠️ [INGEST] Từ chối data hỏng (${hard}) user=${user.username}`);
        return res.status(422).json({ error: `Data cào hỏng: ${hard} — KHÔNG đưa vào queue. Cào lại sản phẩm này.` });
      }
      const { getUserDirsByName } = await import("./state/userDirs");
      const dirs = await getUserDirsByName(user.username);
      if (!dirs?.baseSheinAutoDir) {
        return res.status(400).json({ error: "User chưa cấu hình baseSheinAutoDir" });
      }
      // Validate shops thuộc tài khoản user. Dùng cùng nguồn với /profiles:
      // khi có allowlist xác định (4Seller hoặc explicit) thì chặn shop lạ.
      const resolved = await resolveUserShops(user);
      if (resolved.shops.length > 0 && (resolved.source === "4seller" || resolved.source === "explicit")) {
        const allowed = new Set(resolved.shops);
        const invalid = shops.filter((s) => !allowed.has(s));
        if (invalid.length > 0) {
          return res.status(403).json({ error: `Shop không thuộc tài khoản: ${invalid.join(", ")}` });
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

  // ── Ingest LINKS: tampermonkey gom link sp từ trang LISTING/CATEGORY/SEARCH → đẩy vào
  //    "uncrawled queue" = shop_allocation (status='allocated'). Sau đó crawlAllocated (Chrome/Kiki)
  //    cào detail từng link. KHÁC với POST "/" (cào sẵn detail 1 sp khi user click vào).
  ingestRouter.post("/links", ingestAuth, async (req, res) => {
    try {
      const user = (req as any).tokenUser as AdminUser;
      const { links, shops } = req.body as { links?: any[]; shops?: string[] };
      if (!Array.isArray(links) || links.length === 0) {
        return res.status(400).json({ error: "Thiếu field links (mảng sản phẩm)" });
      }
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.status(400).json({ error: "Phải chọn ít nhất 1 shop" });
      }
      // Validate shops thuộc user (cùng allowlist với /profiles + ingest detail).
      const resolved = await resolveUserShops(user);
      if (resolved.shops.length > 0 && (resolved.source === "4seller" || resolved.source === "explicit")) {
        const allowed = new Set(resolved.shops);
        const invalid = shops.filter((s) => !allowed.has(s));
        if (invalid.length > 0) {
          return res.status(403).json({ error: `Shop không thuộc tài khoản: ${invalid.join(", ")}` });
        }
      }
      const { getDb } = await import("./state/db");
      const db = getDb();
      const excluded = new Set(
        db.prepare("SELECT goods_id FROM excluded_products").all().map((r: any) => String(r.goods_id))
      );
      // niche_key theo từng shop (để crawlAllocated/list biết ngách). Thiếu → null.
      const nicheByShop = new Map<string, string | null>();
      for (const shop of shops) {
        const r = db.prepare("SELECT niche_key FROM shop_niche WHERE shop=? LIMIT 1").get(shop) as any;
        nicheByShop.set(shop, r?.niche_key ?? null);
      }
      // Chuẩn hoá payload → {goods_id, name, price, url, image}. Lọc goodsId hợp lệ + không bị exclude.
      const clean: any[] = [];
      const seen = new Set<string>();
      for (const l of links) {
        const gid = String(
          l.goodsId || l.goods_id || (String(l.url || "").match(/-p-(\d+)\.html/)?.[1]) || ""
        ).trim();
        if (!/^\d{5,}$/.test(gid) || seen.has(gid) || excluded.has(gid)) continue;
        seen.add(gid);
        const url = String(l.url || "").split("?")[0] || `https://us.shein.com/-p-${gid}.html`;
        const price = l.price != null && !isNaN(Number(l.price)) ? Number(l.price) : null;
        clean.push({ goods_id: gid, name: String(l.name || "").slice(0, 200), price, url, image: String(l.image || "") });
      }
      // PK (goods_id, shop) → 1 sp có thể đẩy cho NHIỀU shop (mỗi shop 1 row). Đây là đẩy link
      // THỦ CÔNG (extension chọn shop) nên KHÔNG áp maxShopsPerProduct — theo ý user chọn.
      // INSERT OR IGNORE: (goods_id, shop) đã có → bỏ qua (không đè trạng thái crawled/listed).
      const ins = db.prepare(
        `INSERT OR IGNORE INTO shop_allocation
           (goods_id,shop,niche_key,name,win_score,opportunity_score,price,url,image,status,allocated_at)
         VALUES (@goods_id,@shop,@niche_key,@name,0,@opp,@price,@url,@image,'allocated',@now)`
      );
      const now = Date.now();
      const perShop: Record<string, { added: number; skipped: number }> = {};
      const tx = db.transaction(() => {
        for (const shop of shops) {
          if (/[\/\\]|\.\./.test(shop)) continue;
          const niche = nicheByShop.get(shop) ?? null;
          let added = 0;
          for (const c of clean) {
            // opp=40: ưu tiên thấp hơn sp đã research-allocated (~74-89) → cào sau, không chen hàng.
            const info = ins.run({ ...c, shop, niche_key: niche, opp: 40, now });
            if (info.changes > 0) added++;
          }
          perShop[shop] = { added, skipped: clean.length - added };
        }
      });
      tx();
      const totalAdded = Object.values(perShop).reduce((s, v) => s + v.added, 0);
      console.log(
        `🔗 [INGEST-LINKS] user=${user.username} shops=${shops.join(",")} received=${links.length} valid=${clean.length} added=${totalAdded}`
      );
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, received: links.length, valid: clean.length, perShop });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi ingest links" });
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

  // ── Uncrawled queue manager (shop_allocation) ─────────────
  // Quản lý link sp chờ cào detail: lọc theo shop/status/từ khoá, xoá, đưa cào lại, loại trừ.
  app.get("/admin/api/uncrawled", async (req, res) => {
    try {
      const { getDb } = await import("./state/db");
      const db = getDb();
      const shop = ((req.query.shop as string) || "").trim();
      const status = ((req.query.status as string) || "allocated").trim();
      const q = ((req.query.q as string) || "").trim();
      const limit = Math.min(Number(req.query.limit) || 300, 2000);
      const where: string[] = [];
      const params: any[] = [];
      if (shop) { where.push("shop = ?"); params.push(shop); }
      if (status && status !== "all") { where.push("status = ?"); params.push(status); }
      if (q) { where.push("(name LIKE ? OR goods_id LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const rows = db.prepare(
        `SELECT goods_id, shop, niche_key, name, price, opportunity_score, url, image, status, allocated_at
         FROM shop_allocation ${whereSql}
         ORDER BY allocated_at DESC, opportunity_score DESC LIMIT ?`
      ).all(...params, limit);
      // summary status (giới hạn theo shop nếu đang lọc shop)
      const sumWhere = shop ? "WHERE shop = ?" : "";
      const statusCounts = db.prepare(
        `SELECT status, COUNT(*) c FROM shop_allocation ${sumWhere} GROUP BY status ORDER BY c DESC`
      ).all(...(shop ? [shop] : []));
      const shops = db.prepare(
        "SELECT shop, COUNT(*) c FROM shop_allocation GROUP BY shop ORDER BY shop"
      ).all();
      res.json({ rows, statusCounts, shops, limit });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi load uncrawled" });
    }
  });

  app.post("/admin/api/uncrawled/action", async (req, res) => {
    try {
      const { getDb } = await import("./state/db");
      const db = getDb();
      const { action, goodsIds, shop } = req.body as { action?: string; goodsIds?: string[]; shop?: string };
      if (!Array.isArray(goodsIds) || goodsIds.length === 0) {
        return res.status(400).json({ error: "Thiếu goodsIds" });
      }
      const ids = goodsIds.map(String).filter((x) => /^\d+$/.test(x));
      if (!ids.length) return res.status(400).json({ error: "goodsIds không hợp lệ" });
      const ph = ids.map(() => "?").join(",");
      // PK (goods_id, shop): 1 sp có thể ở nhiều shop. Có shop → scope đúng shop (không đụng
      // row 'crawled'/'listed' của shop khác cùng sp). Không shop → toàn cục (quản lý chung).
      const shopScope = shop ? " AND shop = ?" : "";
      const scopeArgs = shop ? [shop] : [];
      let affected = 0;
      if (action === "delete") {
        affected = db.prepare(`DELETE FROM shop_allocation WHERE goods_id IN (${ph})${shopScope}`).run(...ids, ...scopeArgs).changes;
      } else if (action === "requeue") {
        affected = db.prepare(`UPDATE shop_allocation SET status='allocated' WHERE goods_id IN (${ph})${shopScope}`).run(...ids, ...scopeArgs).changes;
      } else if (action === "recrawl") {
        affected = db.prepare(`UPDATE shop_allocation SET status='recrawl' WHERE goods_id IN (${ph})${shopScope}`).run(...ids, ...scopeArgs).changes;
      } else if (action === "exclude") {
        // Loại trừ vĩnh viễn: thêm excluded_products + xoá khỏi allocation (research/allocate sau sẽ bỏ qua).
        const now = Date.now();
        const insEx = db.prepare("INSERT OR IGNORE INTO excluded_products (goods_id, reason, excluded_at) VALUES (?, 'uncrawled-ui', ?)");
        const del = db.prepare("DELETE FROM shop_allocation WHERE goods_id = ?");
        const tx = db.transaction(() => { for (const id of ids) { insEx.run(id, now); affected += del.run(id).changes; } });
        tx();
      } else {
        return res.status(400).json({ error: "action không hợp lệ (delete|requeue|recrawl|exclude)" });
      }
      refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, affected });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi action" });
    }
  });

  // Trigger CÀO uncrawled qua CHROME (CDP 9222) → ghi JSON → vào listing queue. Stream log realtime.
  // Body: { shop (bắt buộc), n?, goodsIds? }. Có goodsIds → cào đúng các sp đó; không → top-N theo score.
  app.post("/admin/api/uncrawled/crawl", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể cào" });
      const { shop, n, goodsIds } = req.body as { shop?: string; n?: number; goodsIds?: string[] };
      if (!shop) return res.status(400).json({ error: "Thiếu shop (chọn 1 shop cụ thể, không phải 'tất cả')" });
      const limit = Math.min(Math.max(Number(n) || 10, 1), 50);

      const { getDb } = await import("./state/db");
      const db = getDb();
      let items: any[];
      const picked = Array.isArray(goodsIds) ? goodsIds.map(String).filter((x) => /^\d+$/.test(x)) : [];
      if (picked.length) {
        const ph = picked.map(() => "?").join(",");
        items = db.prepare(
          `SELECT goods_id, name, url, status FROM shop_allocation
           WHERE shop=? AND goods_id IN (${ph}) AND status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''`
        ).all(shop, ...picked) as any[];
      } else {
        items = db.prepare(
          `SELECT goods_id, name, url, status FROM shop_allocation
           WHERE shop=? AND status IN ('allocated','recrawl') AND url IS NOT NULL AND url!=''
           ORDER BY (status='recrawl') DESC, opportunity_score DESC LIMIT ?`
        ).all(shop, limit) as any[];
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const send = (line: string) => { try { res.write(line + "\n"); } catch { /* client đóng */ } };

      if (!items.length) { send(`__ERROR__Không có sp 'allocated'/'recrawl' cho ${shop}.`); return res.end(); }

      const { getUserDirsByName } = await import("./state/userDirs");
      const dirs = await getUserDirsByName(sessionUser.username);
      const baseDir = dirs?.baseSheinAutoDir;
      if (!baseDir) { send("__ERROR__User chưa cấu hình baseSheinAutoDir."); return res.end(); }

      const cdpUrl = process.env.CHROME_CDP || "http://127.0.0.1:9222";
      send(`▶ Cào ${items.length} sp [${shop}] qua Chrome ${cdpUrl}`);
      send(`   (Chrome phải đang mở với --remote-debugging-port=9222)`);

      const { scrapeBatchViaChrome } = await import("./core/scrapeViaChrome");
      const { dispatchScrapedData, hardScrapeError } = await import("./core/scrapeViaKiki");
      // PK (goods_id, shop) → mark ĐÚNG shop đang cào, không đụng shop khác cùng sp.
      const markCrawled = db.prepare("UPDATE shop_allocation SET status='crawled' WHERE goods_id=? AND shop=?");
      const markRecrawl = db.prepare("UPDATE shop_allocation SET status='recrawl' WHERE goods_id=? AND shop=?");
      const statusById: Record<string, string> = {};
      for (const it of items) statusById[it.goods_id] = it.status;
      let ok = 0, requeued = 0, failed = 0;

      try {
        await scrapeBatchViaChrome({
          items: items.map((it) => ({ goodsId: String(it.goods_id), url: it.url })),
          cdpUrl,
          onLog: (m) => send(m),
          onProduct: async (goodsId, data, error) => {
            if (data) {
              // HARD GATE: hỏng nặng (thiếu product_name/ảnh/màu) → recrawl, KHÔNG ghi JSON hỏng.
              const hard = hardScrapeError(data);
              if (hard) {
                markRecrawl.run(goodsId, shop); requeued++;
                send(`⚠️ ${goodsId} hỏng: ${hard} → recrawl`);
                return;
              }
              const sc = (data as any).size_chart;
              const hasSize = !!(sc && ((sc.sections && sc.sections.length) || (sc.data && sc.data.length)));
              if (!hasSize && statusById[goodsId] !== "recrawl") {
                markRecrawl.run(goodsId, shop); requeued++;
                send(`⚠️ ${goodsId} thiếu size_chart → recrawl (cào lại lần sau)`);
              } else {
                await dispatchScrapedData(baseDir, data, [shop]);
                markCrawled.run(goodsId, shop); ok++;
                send(`✅ ${goodsId} OK · ${data.listing_variations?.colors?.length || 0} màu → JSON → listing queue`);
              }
            } else {
              failed++;
              send(`❌ ${goodsId} fail: ${error || "?"}`);
            }
          },
        });
        refreshQueueSnapshot().catch(() => {});
        send(`__RESULT__${JSON.stringify({ ok, requeued, failed, total: items.length })}`);
      } catch (e: any) {
        send(`__ERROR__${e?.message ?? e}`);
      }
      res.end();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Lỗi cào uncrawled" });
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });

  // ── Promotion scan (Marketing → Product Discount / Flash Deal) ──────────
  // Cào trạng thái promotion mọi shop (sync từ TikTok trước, như bấm "Sync promotion").
  // Kết quả lưu memory + data/_promo_scan.json (sống qua restart); cron mỗi 2 giờ tự cào.
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

  // Kéo thêm data SHEIN từ RapidAPI cho 1 shop theo NGÁCH của shop → chấm điểm → đổ sp
  // ĐẠT ngưỡng vào uncrawl queue (loại trừ data đã có). KHÔNG kéo bừa.
  app.post("/admin/api/uncrawled/pull-more", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể kéo data" });
      const { shop, pages, minScore, dryRun, resetCursor } = req.body as {
        shop?: string; pages?: number; minScore?: number; dryRun?: boolean; resetCursor?: boolean;
      };
      if (!shop || !shop.trim()) return res.status(400).json({ error: "Thiếu shop" });
      const { pullMoreForShop } = await import("./core/research/pullMoreData");
      const result = await pullMoreForShop({
        shop: shop.trim(),
        pages: pages != null ? Number(pages) : undefined,
        minOpportunity: minScore != null ? Number(minScore) : undefined,
        resetCursor: !!resetCursor,
        dryRun: !!dryRun,
      });
      if (result.totalInserted > 0) refreshQueueSnapshot().catch(() => {});
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi kéo data" });
    }
  });

  // Bật Chrome debug (cổng 9222) cho backend Chrome. Idempotent: đã chạy → trả luôn.
  app.post("/admin/api/chrome/launch", async (req, res) => {
    try {
      const { ensureChromeDebug } = await import("./core/chromeDebug");
      const cdpUrl = process.env.CHROME_CDP || "http://127.0.0.1:9222";
      const r = await ensureChromeDebug(cdpUrl);
      if (r.ok) {
        return res.json({ ok: true, already: r.already, launched: r.launched, exe: r.exe,
          message: r.already ? "Chrome debug đã chạy." : "Đã bật Chrome debug." });
      }
      return res.status(500).json({ error: r.error ?? "Lỗi bật Chrome debug" });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi bật Chrome debug" });
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

  // ── Dashboard OVERVIEW: tổng quan shop (live/đơn/doanh thu + Δ so hôm qua, health,
  //    promotion, queue). Đơn & DT theo NGÀY lấy thẳng từ 4Seller sales API (chính xác);
  //    Live Δ so hôm qua dựa trên snapshot hằng ngày (bảng dashboard_snapshot).
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

      // Mốc ngày theo GIỜ VN (Asia/Ho_Chi_Minh) — rollover nửa đêm VN, khớp lịch làm việc VN.
      // LƯU Ý: 4Seller gom đơn theo NGÀY US (không có granularity giờ) nên sáng VN (~00:00-14:00),
      // ngày US cùng số CHƯA sang → "hôm nay" có thể ~0; số thật của đêm US nằm ở "hôm qua".
      // (User chọn mốc VN chấp nhận đánh đổi này — xem AskUserQuestion 2026-07-06.)
      const vnDay = (offsetDays = 0) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
          new Date(Date.now() - offsetDays * 864e5)
        );
      const today = vnDay(0);
      const yesterday = vnDay(1);

      // Nguồn song song: folder đĩa (pending/fail), live 4Seller, đơn hôm nay/hôm qua, đơn 7 ngày, ảnh đại diện
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

      // Danh sách shop: ưu tiên shop 4Seller thật (union tài khoản); folder đĩa để lấy pending/fail
      const diskByName = new Map(diskShops.map((s) => [s.folder.toLowerCase(), s]));
      const cfg = await loadAdminConfig();
      const u = cfg.users.find((x) => x.username === sessionUser.username);
      const shopSource = u ? await resolveUserShops(u as any) : { shops: [] as string[], source: "empty" };
      const shopNames = shopSource.shops.length ? shopSource.shops : diskShops.map((s) => s.folder);

      // Snapshot: upsert hôm nay + đọc hôm qua (Δ live)
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
        // Sparkline 7 ngày (orders). Hôm nay lấy giá trị LIVE (st.orders) vì snapshot mới upsert.
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
      const diskShops = await scanShopsSummary({ username: ownerScope(req) });
      let liveByShop: Record<string, number> = {};
      let ordersByShop: Record<string, number> = {};
      // BASE = danh sách 4Seller (mọi shop của account hiện tại, KỂ CẢ shop mới chưa có
      // folder/listing) → merge data đĩa vào. Không có cookie 4Seller → fallback folder đĩa.
      let shops = diskShops;
      try {
        const sessionUser = (req.session as any).user as SessionUser | undefined;
        if (sessionUser) {
          const cfg = await loadAdminConfig();
          const u = cfg.users.find((x) => x.username === sessionUser.username);
          if (u) {
            const r = await resolveUserShops(u as any);
            if ((r.source === "4seller" || r.source === "explicit") && r.shops.length) {
              const diskByName = new Map(diskShops.map((s) => [s.folder.toLowerCase(), s]));
              // 1 dòng/shop 4Seller; có folder đĩa → dùng summary, không → 0.
              shops = r.shops.map((name) =>
                diskByName.get(name.toLowerCase()) ?? {
                  owner: u.username, folder: name, pending: 0, success: 0, fail: 0, total: 0, lastActivityMs: 0, cover: null,
                }
              );
            }
            // active thật + số đơn 7 ngày từ 4Seller (mỗi cái cache 5p), gọi song song.
            [liveByShop, ordersByShop] = await Promise.all([
              fetchLiveCounts(u.username),
              fetchOrdersByShop(u.username),
            ]);
          }
        }
      } catch { /* best-effort */ }

      // Enrich: ngách (shop_niche) + uncrawled (shop_allocation) từ shein-auto.db.
      const nicheByShop = new Map<string, string>();
      const uncrawledByShop = new Map<string, number>();
      try {
        const { getDb } = await import("./state/db");
        const db = getDb();
        for (const r of db.prepare("SELECT shop, niche_key FROM shop_niche WHERE niche_key IS NOT NULL").all() as any[]) {
          const k = String(r.shop ?? "").toLowerCase();
          if (k && !nicheByShop.has(k)) nicheByShop.set(k, r.niche_key);
        }
        for (const r of db.prepare(
          "SELECT shop, COUNT(*) c FROM shop_allocation WHERE status IN ('allocated','recrawl') GROUP BY shop"
        ).all() as any[]) {
          if (r.shop) uncrawledByShop.set(String(r.shop).toLowerCase(), r.c);
        }
      } catch { /* best-effort */ }

      // Kiki-TikTok profile per-shop (tiktok.db) — để gán/hiển thị ngay trên Listings.
      const kikiByShop = new Map<string, string>();
      try {
        const edb = new EditDb();
        try { for (const p of edb.allProfiles()) kikiByShop.set(String(p.shop).toLowerCase(), p.kiki_profile); }
        finally { edb.close(); }
      } catch { /* best-effort */ }

      // Phân tích sức khỏe TikTok per-shop (shop_analysis) — cho badge + tab Phân tích.
      const sj = (s: any, d: any) => { try { return JSON.parse(s); } catch { return d; } };
      const healthByShop = new Map<string, any>();
      try {
        const { TiktokDb } = await import("./services/tiktok/db");
        const tdb = new TiktokDb();
        try {
          for (const a of tdb.listShopAnalysis()) {
            healthByShop.set(String(a.shop).toLowerCase(), {
              overall: a.overall ?? null, status: a.status ?? null, summary: a.summary ?? "",
              alerts: sj(a.alerts_json, []), areas: sj(a.areas_json, []), metrics: sj(a.metrics_json, {}),
              reportPath: a.report_path ?? "", runDate: a.run_date ?? null, updatedAt: a.updated_at ?? null,
            });
          }
        } finally { tdb.close(); }
      } catch { /* best-effort */ }

      // Gắn TÀI KHOẢN 4Seller cho từng shop (tab lọc theo tài khoản trên UI).
      const accounts = await fsAccounts().catch(() => []);
      const accountUidByShop = new Map<string, string>();
      const normShop = (x: string) => (x || "").toLowerCase().replace(/[\s—–-]+/g, "");
      for (const acc of accounts) {
        for (const shopName of acc.shops) accountUidByShop.set(normShop(shopName), acc.uid);
      }

      const enriched = shops.map((s) => {
        const lc = s.folder.toLowerCase();
        const accUid = accountUidByShop.get(normShop(s.folder)) ?? (accounts.length === 1 ? accounts[0].uid : null);
        return {
          ...s,
          niche: nicheByShop.get(lc) ?? null,
          uncrawled: uncrawledByShop.get(lc) ?? 0,
          live: lc in liveByShop ? liveByShop[lc] : null, // null = chưa lấy được (no cookie)
          orders: lc in ordersByShop ? ordersByShop[lc] : (Object.keys(ordersByShop).length ? 0 : null),
          kikiProfile: kikiByShop.get(lc) ?? "",
          health: healthByShop.get(lc) ?? null,
          accountUid: accUid,
          accountLabel: accUid ? (accounts.find((a) => a.uid === accUid)?.label ?? null) : null,
        };
      });
      res.json({
        shops: enriched,
        accounts: accounts.map((a) => ({ uid: a.uid, label: a.label, shopCount: a.shops.length })),
      });
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

  // Retry HÀNG LOẠT file Fail → đẩy về folder shop (pending) để cron pick lên lại.
  // body.folder: chỉ retry fail của 1 shop; bỏ trống = TẤT CẢ shop trong scope của user.
  app.post("/admin/api/listings/retry-fails", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể retry" });

      const folder = (req.body?.folder as string) || undefined;
      const fails = await scanListings({ status: "fail", folder, username: ownerScope(req) });
      if (fails.length === 0) {
        return res.json({ ok: true, retried: 0, skipped: [], message: "Không có file Fail nào" });
      }

      let retried = 0;
      const skipped: { id: string; reason: string }[] = [];
      for (const card of fails) {
        try {
          // resolveListingPath validate lại path (chống traversal) như retry đơn lẻ
          const resolved = await resolveListingPath(card.id);
          if (!resolved || resolved.status !== "fail") {
            skipped.push({ id: card.id, reason: "id không hợp lệ" });
            continue;
          }
          if (!(await fs.pathExists(resolved.full))) {
            skipped.push({ id: card.id, reason: "file không còn ở Fail" });
            continue;
          }
          const target = path.join(resolved.baseDir, resolved.folder, resolved.file);
          await fs.move(resolved.full, target, { overwrite: true });
          const errLog = `${resolved.full}.error.log`;
          if (await fs.pathExists(errLog)) await fs.remove(errLog).catch(() => {});
          retried++;
        } catch (e: any) {
          skipped.push({ id: card.id, reason: e?.message ?? "lỗi move" });
        }
      }
      console.log(
        `↻ [retry-fails] ${sessionUser.username} retry ${retried}/${fails.length} file fail${folder ? ` (shop ${folder})` : " (tất cả shop)"}`
      );
      res.json({ ok: true, retried, total: fails.length, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi retry hàng loạt" });
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

      // Gom theo folder shop. processFile lock 1 browser/folder → nhiều file CÙNG shop phải
      // chạy TUẦN TỰ (xong file này mới tới file kia), nếu bắn song song thì 7/8 bị "đang lock, skip".
      type Job = { baseDir: string; folder: string; file: string; owner: string };
      const groups = new Map<string, Job[]>();

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
        const key = `${resolved.baseDir}::${resolved.folder}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ baseDir: resolved.baseDir, folder: resolved.folder, file: resolved.file, owner: trueOwner });
      }

      // Mỗi folder: 1 runner chạy TUẦN TỰ qua các file. Các folder khác nhau chạy SONG SONG.
      for (const jobs of groups.values()) {
        void (async () => {
          for (const j of jobs) {
            try {
              await processFile(j.baseDir, j.folder, j.file, j.owner);
            } catch (err) {
              console.error(`❌ run-batch ${j.folder}/${j.file}:`, err);
            }
          }
        })();
      }

      res.json({ ok: true, spawned, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi run-batch" });
    }
  });

  // POD: quét inbox thủ công → build JSON vào queue (force=true, bỏ qua autoCron gate).
  app.post("/admin/api/pod/scan", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể quét POD" });
      const result = await runPodRouterOnce({ force: true });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi quét POD" });
    }
  });

  // POD: tạo listing từ ảnh kéo-thả trên UI (base64). Body lớn → parser riêng 30mb.
  app.post("/admin/api/pod/create", express.json({ limit: "30mb" }), async (req, res) => {
    let tmpPath = "";
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể tạo POD" });

      const { shop, title, imageBase64 } = req.body as { shop?: string; title?: string; imageBase64?: string };
      if (!shop || /[\/\\]|\.\./.test(shop)) return res.status(400).json({ error: "Shop không hợp lệ" });
      if (!title || !title.trim()) return res.status(400).json({ error: "Thiếu title" });
      if (!imageBase64) return res.status(400).json({ error: "Thiếu ảnh design" });

      // Tách data URL nếu có: "data:image/png;base64,...."
      const m = imageBase64.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
      const ext = m ? (m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase()) : "png";
      const b64 = m ? m[2] : imageBase64;
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0) return res.status(400).json({ error: "Ảnh rỗng / base64 sai" });

      const tmpDir = path.join(process.cwd(), "data", "_pod_tmp");
      await fs.ensureDir(tmpDir);
      tmpPath = path.join(tmpDir, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
      await fs.writeFile(tmpPath, new Uint8Array(buf));

      const r = await ingestPodDesign({ shop, title: title.trim(), designPath: tmpPath });
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi tạo POD" });
    } finally {
      if (tmpPath) await fs.remove(tmpPath).catch(() => {});
    }
  });

  // ── TikTok Auto-Edit (click suggestions) ──────────────────
  // Quản lý: danh sách shop (4Seller) + Kiki profile login TikTok Seller Center của từng shop,
  // và xem listing đã chạy suggestion. Mapping lưu ở data/tiktok.db (KHÁC shop_niche.kiki_profile = SHEIN).
  app.get("/admin/api/tiktok-edit/shops", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      const cfg = await loadAdminConfig();
      const u = cfg.users.find((x) => x.username === sessionUser.username);
      if (!u) return res.status(404).json({ error: "User không tồn tại" });
      const { shops, source } = await resolveUserShops(u as AdminUser);
      const edb = new EditDb();
      try {
        const profMap = new Map(edb.allProfiles().map((p) => [p.shop, p]));
        const countMap = new Map(edb.countsByShop().map((c) => [c.shop, c]));
        const rows = shops.map((shop) => {
          const c = countMap.get(shop);
          return {
            shop,
            kikiProfile: profMap.get(shop)?.kiki_profile ?? "",
            updatedAt: profMap.get(shop)?.updated_at ?? null,
            edited: c?.edited ?? 0,
            failed: c?.failed ?? 0,
          };
        });
        // Tổng edit chưa gán shop (script cũ chạy 1 profile, không ghi shop) → hiển thị riêng.
        const unassigned = countMap.get("") ?? { edited: 0, failed: 0, total: 0 };
        res.json({ shops: rows, source, unassigned });
      } finally {
        edb.close();
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi load shop TikTok edit" });
    }
  });

  app.post("/admin/api/tiktok-edit/profile", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể sửa profile" });
      const { shop, kikiProfile } = req.body as { shop?: string; kikiProfile?: string };
      if (!shop || !shop.trim()) return res.status(400).json({ error: "Thiếu shop" });
      const edb = new EditDb();
      try {
        edb.setProfile(shop.trim(), kikiProfile ?? "");
        res.json({ ok: true, shop: shop.trim(), kikiProfile: (kikiProfile ?? "").trim() });
      } finally {
        edb.close();
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu profile" });
    }
  });

  app.get("/admin/api/tiktok-edit/edited", async (req, res) => {
    try {
      const shop = ((req.query.shop as string) || "").trim();
      const status = ((req.query.status as string) || "").trim();
      const limit = Math.min(Number(req.query.limit) || 500, 5000);
      const edb = new EditDb();
      try {
        const rows = edb.listEdited({ shop: shop || undefined, status: status || undefined, limit });
        res.json({ rows, total: rows.length });
      } finally {
        edb.close();
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi load listing đã edit" });
    }
  });

  // Trend view per-listing của 1 shop: hôm nay vs hôm qua + tăng trưởng ~7 ngày
  // (nguồn: listing_views, route product-manage ghi mỗi lần crawl TikTok).
  app.get("/admin/api/tiktok/listing-views", async (req, res) => {
    try {
      const shop = ((req.query.shop as string) || "").trim();
      if (!shop) return res.status(400).json({ error: "Thiếu shop" });
      const { TiktokDb } = await import("./services/tiktok/db");
      const tdb = new TiktokDb();
      try {
        res.json(tdb.getListingViewTrends(shop));
      } finally {
        tdb.close();
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi load listing views" });
    }
  });

  // Chạy phân tích sức khỏe TikTok cho 1 shop (onlyShop) hoặc TẤT CẢ (chạy nền, không chờ).
  app.post("/admin/api/shop-analysis/run", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể chạy phân tích" });
      const { shop } = req.body as { shop?: string };
      const { runTiktokJob } = await import("./core/tiktokCron");
      // Fire-and-forget — crawl Kiki mất vài phút/shop. Guard 'running' bên trong tự chống chạy chồng.
      runTiktokJob({ onlyShop: shop?.trim() || undefined, onLog: (m) => console.log("[tiktok-ui]", m) })
        .catch((e) => console.error("[tiktok-ui] lỗi:", e?.message ?? e));
      res.json({ ok: true, message: shop ? `Đang phân tích "${shop}" (chạy nền).` : "Đang phân tích TẤT CẢ shop (chạy nền)." });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi chạy phân tích" });
    }
  });

  // Chạy auto-edit cho 1 shop (Kiki mở TikTok Seller Center, click suggestion + Update). Stream log.
  // Kiki chỉ chạy 1 profile/lần → guard chống chạy song song.
  let autoEditRunning = false;
  app.post("/admin/api/tiktok-edit/run", async (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể chạy" });
    const { shop, n, dryRun } = req.body as { shop?: string; n?: number; dryRun?: boolean };
    if (!shop || !shop.trim()) return res.status(400).json({ error: "Thiếu shop" });
    if (autoEditRunning) {
      return res.status(409).json({ error: "Đang có 1 phiên auto-edit chạy (Kiki chỉ 1 profile/lần). Đợi xong rồi chạy." });
    }
    // Lấy profile đã gán
    let profile = "";
    const edbP = new EditDb();
    try { profile = edbP.getProfile(shop.trim()) || ""; } finally { edbP.close(); }
    if (!profile) return res.status(400).json({ error: `Shop "${shop}" chưa gán Kiki profile.` });

    const limit = Math.min(Math.max(Number(n) || 50, 1), 200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (line: string) => { try { res.write(line + "\n"); } catch { /* client đóng */ } };

    autoEditRunning = true;
    try {
      const { runAutoEdit } = await import("./scripts/tiktokAutoEdit");
      send(`▶ Auto-edit [${shop}] · profile ${profile} · tối đa ${limit}${dryRun ? " · DRY-RUN (không Update)" : ""}`);
      const r = await runAutoEdit({ profileId: profile, shop: shop.trim(), n: limit, dryRun: !!dryRun, onLog: (m) => send(m) });
      send(`__RESULT__${JSON.stringify(r)}`);
    } catch (e: any) {
      send(`__ERROR__${e?.message ?? e}`);
    } finally {
      autoEditRunning = false;
      res.end();
    }
  });

  // POD: đọc/ghi template config (attributes, giá, màu, size, ngách).
  const POD_FILE = path.resolve(process.cwd(), "config", "pod.json");
  app.get("/admin/api/pod/config", async (_req, res) => {
    try {
      res.json(JSON.parse(await fs.readFile(POD_FILE, "utf-8")));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Không đọc được pod.json" });
    }
  });
  app.post("/admin/api/pod/config", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể sửa config POD" });

      const b = req.body as Record<string, any>;
      const existing = JSON.parse(await fs.readFile(POD_FILE, "utf-8"));
      const merged = { ...existing };

      // Các field UI cho sửa — validate nhẹ, giữ nguyên size_chart/measure_guide/descriptionTemplate.
      if (b.finalPrice !== undefined) {
        const p = String(b.finalPrice).replace(/[^0-9.]/g, "");
        if (!p || isNaN(Number(p))) return res.status(400).json({ error: "Giá không hợp lệ" });
        merged.finalPrice = p;
      }
      const cleanArr = (v: any) =>
        Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
      if (b.sizes !== undefined) {
        const a = cleanArr(b.sizes);
        if (!a?.length) return res.status(400).json({ error: "Cần ít nhất 1 size" });
        merged.sizes = a;
      }
      if (b.palette !== undefined) {
        const a = cleanArr(b.palette);
        if (!a?.length) return res.status(400).json({ error: "Cần ít nhất 1 màu" });
        merged.palette = a;
      }
      if (b.categories !== undefined) {
        const a = cleanArr(b.categories);
        if (!a?.length) return res.status(400).json({ error: "Cần ít nhất 1 ngách" });
        merged.categories = a;
      }
      if (b.attributes !== undefined && b.attributes && typeof b.attributes === "object") {
        const attrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.attributes)) {
          const key = String(k).trim();
          const val = String(v ?? "").trim();
          if (key && val) attrs[key] = val;
        }
        if (Object.keys(attrs).length < 2)
          return res.status(400).json({ error: "Cần ≥2 attribute (để sinh mô tả)" });
        merged.attributes = attrs;
      }
      if (b.colorsPerListing && typeof b.colorsPerListing === "object") {
        const min = Math.max(1, Number(b.colorsPerListing.min) || 1);
        const max = Math.max(min, Number(b.colorsPerListing.max) || min);
        merged.colorsPerListing = { min, max };
      }
      if (b.materialsPick && typeof b.materialsPick === "object") {
        const min = Math.max(0, Number(b.materialsPick.min) || 0);
        const max = Math.max(min, Number(b.materialsPick.max) || min);
        merged.materialsPick = { min, max };
      }
      if (b.sizeSurcharge !== undefined && b.sizeSurcharge && typeof b.sizeSurcharge === "object") {
        const sc: Record<string, number> = {};
        for (const [k, v] of Object.entries(b.sizeSurcharge)) {
          const key = String(k).trim();
          const n = Number(v);
          if (key && !isNaN(n) && n !== 0) sc[key] = n;
        }
        merged.sizeSurcharge = sc;
      }
      if (b.auxImages !== undefined) {
        const n = Math.max(0, Math.floor(Number(b.auxImages)));
        if (!isNaN(n)) merged.auxImages = n;
      }
      if (b.brand_name !== undefined) merged.brand_name = String(b.brand_name).trim();
      if (b.materialDir !== undefined) merged.materialDir = String(b.materialDir).trim();

      await fs.writeFile(POD_FILE, JSON.stringify(merged, null, 2), "utf-8");
      reloadAppConfig();
      res.json({ ok: true, config: merged });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi lưu config POD" });
    }
  });

  // Cào ảnh website (pagination / loadmore) → lưu theo title, nâng width.
  app.post("/admin/api/crawl-images", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể cào" });
      const b = req.body as {
        url?: string; mode?: string; targetWidth?: number; outputDir?: string;
        maxPages?: number; maxLoadMore?: number; maxImages?: number; loadMoreSelector?: string;
        linkPattern?: string; cardSelector?: string; titleSelector?: string;
      };
      if (!b.url || !/^https?:\/\//i.test(b.url)) return res.status(400).json({ error: "URL không hợp lệ" });
      const mode = b.mode === "loadmore" ? "loadmore" : "pagination";

      // Folder lưu: ưu tiên outputDir user nhập; rỗng → mặc định data/crawled-images/<slug>.
      let dir: string;
      const custom = (b.outputDir || "").trim();
      if (custom) {
        dir = path.isAbsolute(custom) ? path.normalize(custom) : path.resolve(process.cwd(), custom);
      } else {
        let slug = "site";
        try {
          const u = new URL(b.url);
          slug = (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
        } catch { /* keep default */ }
        dir = path.join(process.cwd(), "data", "crawled-images", slug);
      }

      // STREAM log realtime (chunked) → UI thấy tiến độ ngay, không kẹt ở "đang khởi động".
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      const send = (line: string) => { try { res.write(line + "\n"); } catch { /* client đóng */ } };
      send(`🔎 Cào: ${b.url} · mode=${mode} · width=${Number(b.targetWidth) || 1280}`);
      try {
        const r = await crawlImages({
          url: b.url,
          mode,
          outputDir: dir,
          targetWidth: Number(b.targetWidth) || 1280,
          maxPages: Number(b.maxPages) || 20,
          maxLoadMore: Number(b.maxLoadMore) || 30,
          maxImages: Number(b.maxImages) || 0,
          loadMoreSelector: b.loadMoreSelector || undefined,
          linkPattern: b.linkPattern || undefined,
          cardSelector: b.cardSelector || undefined,
          titleSelector: b.titleSelector || undefined,
          headless: true,
          onLog: (m) => send(m),
        });
        send(`__RESULT__${JSON.stringify(r)}`);
      } catch (e: any) {
        send(`__ERROR__${e?.message ?? e}`);
      }
      res.end();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Lỗi cào ảnh" });
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });

  // POD material — quản lý ảnh material (xem/upload/xoá) trong folder đang cấu hình.
  const MAT_NAME = /^[^\/\\]+\.(png|jpe?g|webp)$/i;
  const safeMatName = (n: any): string | null => {
    const s = String(n ?? "");
    return MAT_NAME.test(s) && !s.includes("..") ? s : null;
  };

  app.get("/admin/api/pod/materials", async (_req, res) => {
    try {
      const dir = resolvePodMaterialDir();
      let items: { name: string; size: number }[] = [];
      if (await fs.pathExists(dir)) {
        const files = (await fs.readdir(dir)).filter((f) => MAT_NAME.test(f));
        items = await Promise.all(
          files.map(async (name) => ({ name, size: (await fs.stat(path.join(dir, name))).size }))
        );
      }
      res.json({ dir, items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc material" });
    }
  });

  app.get("/admin/api/pod/materials/file", async (req, res) => {
    const name = safeMatName(req.query.name);
    if (!name) return res.status(400).end();
    const fp = path.join(resolvePodMaterialDir(), name);
    if (!(await fs.pathExists(fp))) return res.status(404).end();
    res.sendFile(fp);
  });

  app.post("/admin/api/pod/materials", express.json({ limit: "30mb" }), async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể upload" });
      const { fileName, imageBase64 } = req.body as { fileName?: string; imageBase64?: string };
      if (!imageBase64) return res.status(400).json({ error: "Thiếu ảnh" });
      const m = imageBase64.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
      const ext = m ? (m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase()) : "png";
      const b64 = m ? m[2] : imageBase64;
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) return res.status(400).json({ error: "Ảnh rỗng" });

      // Tên file: giữ tên gốc (sanitize) hoặc random; tránh ghi đè bằng cách thêm hậu tố nếu trùng.
      const baseRaw = (fileName || "").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
      const base = baseRaw || `mat_${crypto.randomBytes(4).toString("hex")}`;
      const dir = resolvePodMaterialDir();
      await fs.ensureDir(dir);
      let name = `${base}.${ext}`;
      let i = 1;
      while (await fs.pathExists(path.join(dir, name))) name = `${base}_${i++}.${ext}`;
      await fs.writeFile(path.join(dir, name), new Uint8Array(buf));
      res.json({ ok: true, name });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi upload material" });
    }
  });

  app.delete("/admin/api/pod/materials", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể xoá" });
      const name = safeMatName(req.query.name);
      if (!name) return res.status(400).json({ error: "Tên file không hợp lệ" });
      await fs.remove(path.join(resolvePodMaterialDir(), name));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi xoá material" });
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

      // Gộp shop từ MỌI tài khoản 4Seller (nhớ principal của từng shop để đếm đúng cookie)
      let shops: (FourSellerShopT & { _principal: string })[] = [];
      for (const principal of await fsPrincipals(sessionUser.username)) {
        try {
          const shopList = await fsGetShopList(principal);
          shops.push(...(shopList.records ?? []).map((s) => ({ ...s, _principal: principal })));
        } catch { /* 1 tài khoản lỗi → bỏ qua */ }
      }

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
            const c = await fsGetStatusCount(s._principal, { shopId: s.id });
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
      const niche = ((req.query.niche as string) || "").trim() || undefined;
      const limit = Math.min(200, Number(req.query.limit ?? 100));
      const offset = Number(req.query.offset ?? 0);
      let { items, total } = researchStore.listCandidates({ day, status, niche, limit, offset });
      let source = "candidate";
      // Ngách chưa lọt top-candidate → fallback hiện MỌI sp ngách đó từ research_product.
      if (niche && total === 0) {
        items = researchStore.listProductsAsCandidates(day, niche, limit);
        total = items.length;
        source = "product";
      }
      res.json({ day, total, source, candidates: items });
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

  // P3 Demand: thu Kalodata (TikTok US) qua Kiki → Signal Store (async)
  let demandRunning = false;
  app.post("/admin/api/research/collect-demand", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    if (demandRunning) return res.status(409).json({ error: "Đang thu demand, chờ xong đã" });
    demandRunning = true;
    res.json({ ok: true, started: true });
    runDemandCollection({ onLog: (m) => console.log("[demand]", m) })
      .catch((e) => console.error("[demand] lỗi:", e?.message ?? e))
      .finally(() => { demandRunning = false; });
  });

  app.get("/admin/api/research/demand", (req, res) => {
    try {
      const day = ((req.query.day as string) || kalodataStore.latestDay() || "").trim();
      if (!day) return res.json({ day: null, categories: [] });
      const sort = (req.query.sort as string) || "growth";
      const fashionOnly = req.query.all !== "1"; // mặc định CHỈ thời trang (loại jewelry/phone…)
      let cats = kalodataStore.listCategories(day);
      if (fashionOnly) cats = cats.filter((c) => isFashionCategory(c.name));
      if (sort === "growth") cats = [...cats].sort((a, b) => (b.growthRate ?? -9) - (a.growthRate ?? -9));
      res.json({ day, total: cats.length, fashionOnly, categories: cats.slice(0, 40) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi đọc demand" });
    }
  });

  // Niche Lab P1: DropScore — xếp hạng ngách "ngon cho dropship" (rẻ+trend+ít refund)
  app.get("/admin/api/research/dropscore", (req, res) => {
    try {
      const day = ((req.query.day as string) || researchStore.listDays()[0] || researchToday()).trim();
      res.json({ day, niches: computeDropScores(day) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi DropScore" });
    }
  });

  // Niche Lab P2: danh mục shop × ngách
  app.get("/admin/api/research/shop-niche", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      let shops: string[] = [];
      try {
        const cfg = await loadAdminConfig();
        const u = cfg.users.find((x) => x.username === sessionUser.username);
        if (u) shops = (await resolveUserShops(u as any)).shops;
      } catch { /* ignore */ }
      const day = researchStore.listDays()[0] || researchToday();
      const niches = computeDropScores(day).map((d) => ({ nicheKey: d.nicheKey, group: d.group, dropScore: d.dropScore, medianCost: d.medianCost }));
      res.json({ shops, day, niches, assignments: shopNicheStore.listAll() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi shop-niche" });
    }
  });

  app.post("/admin/api/research/shop-niche/assign", (req, res) => {
    const u = (req.session as any).user as SessionUser;
    if (u.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    const { shop, nicheKey } = req.body || {};
    if (!shop || !nicheKey) return res.status(400).json({ error: "Thiếu shop/nicheKey" });
    shopNicheStore.assign(String(shop), String(nicheKey));
    res.json({ ok: true });
  });

  app.post("/admin/api/research/shop-niche/remove", (req, res) => {
    const u = (req.session as any).user as SessionUser;
    if (u.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    const { shop, nicheKey } = req.body || {};
    if (!shop || !nicheKey) return res.status(400).json({ error: "Thiếu shop/nicheKey" });
    shopNicheStore.remove(String(shop), String(nicheKey));
    res.json({ ok: true });
  });

  app.post("/admin/api/research/shop-niche/status", (req, res) => {
    const u = (req.session as any).user as SessionUser;
    if (u.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    const { shop, nicheKey, status } = req.body || {};
    if (!shop || !nicheKey || !["testing", "scaling", "dropped"].includes(status))
      return res.status(400).json({ error: "Thiếu/sai tham số" });
    shopNicheStore.setStatus(String(shop), String(nicheKey), status as ShopNicheStatus);
    res.json({ ok: true });
  });

  // Drill-down 1 ngách demand: product SHEIN (nguồn cung) + Kalodata (best-seller TikTok)
  app.get("/admin/api/research/category-drill", async (req, res) => {
    try {
      const name = ((req.query.name as string) || "").trim();
      if (!name) return res.status(400).json({ error: "name required" });
      const day = kalodataStore.latestDay() || "";
      // Kalodata: best-seller TikTok trong ngách (đã pre-pull khi thu demand)
      const kalodata = day ? kalodataStore.listProductsByCategory(day, name, 24) : [];
      // SHEIN: search nguồn cung theo tên ngách → rank win
      const kw = name.replace(/women'?s|men'?s|girl'?s|boy'?s/gi, "").trim() || name;
      let shein: any[] = [];
      try {
        const r = await sheinSearch(kw, { perPage: 24, country: "us" });
        shein = rankByWin(r.products).slice(0, 18);
      } catch { /* shein optional */ }
      res.json({ name, day, query: kw, kalodataAvailable: kalodata.length > 0, kalodata, shein });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Lỗi drill-down ngách" });
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

  // Soi 1 ngách: pre-filter + promote top sp → candidate → validate (Kiki) → verdict
  app.post("/admin/api/research/validate-niche", (req, res) => {
    const sessionUser = (req.session as any).user as SessionUser;
    if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được" });
    if (validateRunning) return res.status(409).json({ error: "Validate đang chạy, chờ xong đã" });
    const niche = ((req.body?.niche as string) || "").trim();
    const profileId = ((req.body?.profileId as string) || "").trim();
    if (!niche) return res.status(400).json({ error: "Thiếu niche" });
    if (!profileId) return res.status(400).json({ error: "Thiếu Kiki profileId" });
    const day = ((req.body?.day as string) || "").trim() || researchStore.listDays()[0] || researchToday();
    const limit = Math.min(40, Number(req.body?.limit ?? 15));
    const promoted = researchStore.promoteNicheProducts(day, niche, limit);
    if (promoted === 0) return res.json({ ok: true, promoted: 0, note: "Không sp nào qua pre-filter (rating≥4 / giá≤max / không IP)" });
    validateRunning = true;
    res.json({ ok: true, started: true, promoted });
    validateCandidates({ profileId, day, niche, limit, onLog: (m) => console.log("[validate-niche]", m) })
      .catch((e) => console.error("[validate-niche] lỗi:", e?.message ?? e))
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
    if (req.params.id.startsWith("prod:")) return res.json({ ok: true, skipped: true }); // sp tạm, không có row để bỏ
    const c = researchStore.updateCandidate(req.params.id, { status: "dismissed" });
    if (!c) return res.status(404).json({ error: "Không tìm thấy candidate" });
    res.json({ ok: true, candidate: c });
  });

  // Duyệt 1-click: cào sp bằng Kiki → đẩy vào shop → status=queued
  app.post("/admin/api/research/candidates/:id/queue", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không được đăng" });

      const isProduct = req.params.id.startsWith("prod:");
      const cand = researchStore.findCandidate(req.params.id) ?? researchStore.findProductCandidate(req.params.id);
      if (!cand) return res.status(404).json({ error: "Không tìm thấy candidate/sản phẩm" });
      if (!cand.url) return res.status(400).json({ error: "Thiếu URL sản phẩm" });

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
      // Candidate thật → update; sp từ research_product → tạo candidate queued (để track + listedCount).
      let updated;
      if (isProduct) { researchStore.markProductQueued(cand, shop); updated = { ...cand, status: "queued", targetShop: shop }; }
      else { updated = researchStore.updateCandidate(cand.id, { status: "queued", targetShop: shop }); }
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

  // ── Cookie 4Seller (ĐA TÀI KHOẢN — auto-detect qua cookie `uid`) ─────────
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

  // POST: nhận 1 file cookie export (paste hoặc kéo-thả). Tự detect tài khoản qua
  // cookie `uid` → kéo 2 file của 2 tài khoản vào là ra 2 tài khoản riêng.
  app.post("/admin/api/cookie", async (req, res) => {
    try {
      const sessionUser = (req.session as any).user as SessionUser;
      if (sessionUser.role === "viewer") return res.status(403).json({ error: "Viewer không thể upload cookie" });

      const body = req.body as { cookie: any };
      const { account, shopSyncError } = await saveAccountCookie(body.cookie);
      // Đổi cookie / thêm shop → xoá cache để Listings phản ánh ngay
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

  // Chuyển đổi mượt: import cookie legacy (data/cookies/<user>.json) vào registry
  // tài khoản 1 lần khi start (file có uid/userToken mới import được).
  bootstrapLegacyCookies().catch(() => {});

  const port = Number(process.env.ADMIN_PORT ?? 3000);
  // Bind tường minh: resolve khi listening, REJECT khi lỗi (vd EADDRINUSE = đã có
  // instance khác). Để index.ts thoát hẳn → tránh chạy nhiều instance cron song song
  // (mỗi instance có folderLocks riêng → đăng TRÙNG cùng 1 file nhiều lần).
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => {
      console.log(`🌐 Admin UI đang chạy tại http://localhost:${port}/admin`);
      resolve();
    });
    server.once("error", (err) => reject(err));
  });
};
