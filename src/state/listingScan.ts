import fs from "fs-extra";
import path from "path";
import { getAllUserDirs, UserDirs } from "./userDirs";
import { historyStore } from "./historyStore";
import { config } from "../config";
import { deriveNiche } from "../utils/deriveNiche";

export type ListingStatus = "pending" | "success" | "fail";

export interface ListingCard {
  /** Stable id dùng cho retry/delete API. Format: "<owner>::<folder>/<status>/<file>" */
  id: string;
  owner: string;
  folder: string;
  file: string;
  status: ListingStatus;
  title: string;
  image: string | null;
  priceRange: { min: number; max: number; currency: string } | null;
  variantCount: number;
  colorCount: number;
  sizeCount: number;
  scrapedAt: string | null;
  mtimeMs: number;
  errorMessage?: string;
  /** URL relative để load screenshot debug (vd "/admin/data/screenshots/xxx.png") */
  screenshotUrl?: string;
  /** Ngách suy từ category breadcrumb + tên sp (deriveNiche). null nếu không khớp. */
  niche?: string | null;
}

export interface ShopSummary {
  owner: string;
  folder: string;
  pending: number;
  success: number;
  fail: number;
  total: number;
  lastActivityMs: number;
  cover: string | null;
  /** Số listing đăng thành công hôm nay / hôm qua (mốc ngày theo GMT-7). */
  todayCount: number;
  yesterdayCount: number;
}

const parsePrice = (raw: any): number | null => {
  if (raw == null) return null;
  const s = String(raw).replace(/,/g, ".");
  const cleaned = s.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
};

const detectCurrency = (raw: any): string => {
  const s = String(raw ?? "");
  if (s.includes("$")) return "$";
  if (s.includes("€")) return "€";
  if (s.includes("£")) return "£";
  return "$";
};

const buildId = (owner: string, folder: string, status: ListingStatus, file: string): string => {
  const statusSeg = status === "pending" ? "_" : status;
  return `${owner}::${folder}/${statusSeg}/${file}`;
};

const parseListingFile = async (
  filePath: string,
  owner: string,
  folder: string,
  status: ListingStatus,
  /** Đã đọc sẵn (scanHub cần thêm field raw) → khỏi đọc + parse file lần 2. */
  pre?: { stat: fs.Stats; data: any }
): Promise<ListingCard | null> => {
  try {
    const stat = pre?.stat ?? (await fs.stat(filePath));
    const data = pre?.data ?? JSON.parse(await fs.readFile(filePath, "utf-8"));
    const file = path.basename(filePath);
    const id = buildId(owner, folder, status, file);

    let image: string | null = null;
    if (Array.isArray(data.product_images) && data.product_images.length > 0) {
      image = data.product_images[0];
    } else if (Array.isArray(data.variant_images) && data.variant_images.length > 0) {
      const first = data.variant_images[0];
      if (first && typeof first === "object") {
        const urls = Object.values(first)[0];
        if (Array.isArray(urls) && urls.length > 0) image = urls[0] as string;
        else if (typeof urls === "string") image = urls;
      }
    }

    let priceRange: ListingCard["priceRange"] = null;
    if (Array.isArray(data.variant_price) && data.variant_price.length > 0) {
      const prices: number[] = [];
      let currency = "$";
      for (const item of data.variant_price) {
        for (const [, v] of Object.entries(item)) {
          const p = parsePrice(v);
          if (p !== null) {
            prices.push(p);
            currency = detectCurrency(v);
          }
        }
      }
      if (prices.length > 0) {
        priceRange = { min: Math.min(...prices), max: Math.max(...prices), currency };
      }
    }

    const colors = Array.isArray(data?.listing_variations?.colors)
      ? data.listing_variations.colors.length
      : 0;
    const sizes = Array.isArray(data?.listing_variations?.sizes)
      ? data.listing_variations.sizes.length
      : 0;
    const variantCount = colors * sizes || colors || sizes || 0;

    let errorMessage: string | undefined;
    let screenshotUrl: string | undefined;
    if (status === "fail") {
      const logPath = `${filePath}.error.log`;
      if (await fs.pathExists(logPath)) {
        try {
          const log = await fs.readFile(logPath, "utf-8");
          errorMessage = log.length > 800 ? log.slice(0, 800) + "..." : log;
          // Parse "Screenshot: <path>" line từ error log
          const m = log.match(/Screenshot:\s*([^\r\n]+\.png)/i);
          if (m) {
            const scFileName = path.basename(m[1].trim());
            screenshotUrl = `/admin/data/screenshots/${scFileName}`;
          }
        } catch {
          // ignore
        }
      }
    }

    return {
      id,
      owner,
      folder,
      file,
      status,
      title: typeof data.product_name === "string" ? data.product_name : "(no title)",
      image,
      priceRange,
      variantCount,
      colorCount: colors,
      sizeCount: sizes,
      scrapedAt: typeof data.scraped_at === "string" ? data.scraped_at : null,
      mtimeMs: stat.mtimeMs,
      errorMessage,
      screenshotUrl,
      niche: deriveNiche(`${data?.category || ""} ${typeof data.product_name === "string" ? data.product_name : ""}`),
    };
  } catch {
    return null;
  }
};

const listJsonsIn = async (dir: string): Promise<string[]> => {
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.toLowerCase().endsWith(".json"));
};

/**
 * 1 lần readdir + stat SONG SONG → số file .json + file mới nhất, dùng chung cho đếm và ảnh bìa.
 * Trước đây countJsons và pickCoverImage mỗi cái stat lại TỪNG file, tuần tự (await trong vòng for)
 * → ~5000 file Success x2 = ~10k lượt chờ đĩa nối đuôi → /listings/progress mất ~2.4s.
 */
const dirStats = async (dir: string): Promise<{ count: number; mtimeMs: number; newest: string | null }> => {
  let jsons: string[];
  try { jsons = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json")); }
  catch { return { count: 0, mtimeMs: 0, newest: null }; }
  const mts = await Promise.all(jsons.map((f) => fs.stat(path.join(dir, f)).then((st) => st.mtimeMs, () => 0)));
  let i = -1;
  mts.forEach((m, k) => { if (i < 0 || m > mts[i]) i = k; });
  return { count: jsons.length, mtimeMs: i < 0 ? 0 : mts[i], newest: i < 0 ? null : path.join(dir, jsons[i]) };
};

/** Ảnh bìa folder = ảnh đầu của file mới nhất. Cache theo folder+(file,mtime) → chỉ parse lại khi có file mới. */
const coverCache = new Map<string, { key: string; img: string | null }>();
const coverOf = async (folderPath: string, file: string, mtimeMs: number): Promise<string | null> => {
  const key = `${file}|${mtimeMs}`;
  const hit = coverCache.get(folderPath);
  if (hit && hit.key === key) return hit.img;
  let img: string | null = null;
  try {
    const data = JSON.parse(await fs.readFile(file, "utf-8"));
    if (Array.isArray(data.product_images) && data.product_images.length > 0) img = data.product_images[0];
    else if (Array.isArray(data.variant_images) && data.variant_images.length > 0) {
      const urls = Object.values(data.variant_images[0])[0];
      if (Array.isArray(urls) && urls.length > 0) img = urls[0] as string;
    }
  } catch { /* file hỏng → không có ảnh */ }
  coverCache.set(folderPath, { key, img });
  return img;
};

/**
 * Card đã parse, dùng lại khi file không đổi (mtime+size; Fail tính thêm mtime file .error.log vì
 * errorMessage đọc từ đó). Trước đây scanListings parse lại TỪNG file, tuần tự, mỗi lần gọi (~1s).
 * ponytail: entry của file đã chuyển/xoá vẫn nằm lại (vài nghìn card nhỏ) — dọn khi thấy RAM đáng kể.
 */
const CARD_BATCH = 100;
const cardCache = new Map<string, { sig: string; card: ListingCard | null }>();
const cachedCard = async (fp: string, owner: string, folder: string, status: ListingStatus): Promise<ListingCard | null> => {
  const st = await fs.stat(fp).catch(() => null);
  if (!st) return null;
  let sig = `${st.mtimeMs}:${st.size}:${owner}:${folder}:${status}`;
  if (status === "fail") sig += `|${(await fs.stat(`${fp}.error.log`).catch(() => null))?.mtimeMs ?? 0}`;
  const hit = cardCache.get(fp);
  if (hit && hit.sig === sig) return hit.card;
  const card = await parseListingFile(fp, owner, folder, status);
  cardCache.set(fp, { sig, card });
  return card;
};

/**
 * Scan tất cả user dirs hoặc 1 user cụ thể. Filter theo status/folder.
 *
 * @param opts.username  nếu set, chỉ scan dirs của user này (UI-side filtering)
 */
export const scanListings = async (opts?: {
  status?: ListingStatus;
  folder?: string;
  username?: string;
}): Promise<ListingCard[]> => {
  const allDirs = await getAllUserDirs();
  const targetDirs = opts?.username
    ? allDirs.filter((d) => d.username.split(",").includes(opts.username!))
    : allDirs;

  const cards: ListingCard[] = [];
  for (const dirs of targetDirs) {
    const cardsForUser = await scanListingsInDir(dirs, opts);
    cards.push(...cardsForUser);
  }
  cards.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cards;
};

const scanListingsInDir = async (
  dirs: UserDirs,
  opts?: { status?: ListingStatus; folder?: string }
): Promise<ListingCard[]> => {
  const { username, baseSheinAutoDir, profiles } = dirs;
  if (!(await fs.pathExists(baseSheinAutoDir))) return [];

  const entries = await fs.readdir(baseSheinAutoDir);
  let folders = entries.filter((n) => !n.startsWith(".") && n !== "Success" && n !== "Fail");
  if (opts?.folder) {
    // Xem chi tiết 1 shop cụ thể → cho phép mọi folder có trên đĩa (kể cả ngoài profiles),
    // để thấy được fail/listing của shop không nằm trong allowlist.
    folders = folders.filter((f) => f === opts.folder);
  } else if (profiles.length > 0) {
    folders = folders.filter((f) => profiles.includes(f));
  }

  const cards: ListingCard[] = [];
  for (const folderName of folders) {
    const folderPath = path.join(baseSheinAutoDir, folderName);
    try {
      const stats = await fs.stat(folderPath);
      if (!stats.isDirectory()) continue;
    } catch {
      continue;
    }

    const wantStatuses: ListingStatus[] = opts?.status
      ? [opts.status]
      : ["pending", "success", "fail"];

    for (const status of wantStatuses) {
      const dir =
        status === "pending"
          ? folderPath
          : path.join(folderPath, status === "success" ? "Success" : "Fail");
      const files = await listJsonsIn(dir);
      for (let i = 0; i < files.length; i += CARD_BATCH) {
        const batch = await Promise.all(
          files.slice(i, i + CARD_BATCH).map((file) => cachedCard(path.join(dir, file), username, folderName, status))
        );
        for (const card of batch) if (card) cards.push(card);
      }
    }
  }
  return cards;
};

export const scanShopsSummary = async (opts?: {
  username?: string;
  /** Gồm cả shop có trong profiles nhưng CHƯA tạo folder trên đĩa (counts = 0).
   *  Dùng cho picker clone — clone sẽ tự ensureDir folder khi ghi. */
  includeEmptyProfiles?: boolean;
  /** Quét MỌI folder trên đĩa (bỏ qua allowlist `profiles`) — để overview thấy hết
   *  fail/pending của cả shop ngoài profiles. profiles chỉ nên dùng cho worker routing. */
  allFolders?: boolean;
}): Promise<ShopSummary[]> => {
  const allDirs = await getAllUserDirs();
  const targetDirs = opts?.username
    ? allDirs.filter((d) => d.username.split(",").includes(opts.username!))
    : allDirs;

  const summaries: ShopSummary[] = [];
  for (const dirs of targetDirs) {
    const { username, baseSheinAutoDir, profiles } = dirs;
    const baseExists = await fs.pathExists(baseSheinAutoDir);

    let folders: string[];
    if (profiles.length > 0 && !opts?.allFolders) {
      // includeEmptyProfiles → toàn bộ profile (kể cả chưa có folder); ngược lại chỉ folder đã tồn tại ∩ profiles.
      if (opts?.includeEmptyProfiles) {
        folders = [...profiles];
      } else {
        if (!baseExists) continue;
        const entries = await fs.readdir(baseSheinAutoDir);
        folders = entries.filter((n) => !n.startsWith(".") && n !== "Success" && n !== "Fail" && profiles.includes(n));
      }
    } else {
      // allFolders hoặc profiles rỗng → quét mọi folder có trên đĩa.
      if (!baseExists) continue;
      const entries = await fs.readdir(baseSheinAutoDir);
      folders = entries.filter((n) => !n.startsWith(".") && n !== "Success" && n !== "Fail");
    }

    // Các shop độc lập nhau → quét SONG SONG thay vì lần lượt từng shop.
    await Promise.all(folders.map(async (folderName) => {
      const folderPath = path.join(baseSheinAutoDir, folderName);
      let isDir = false;
      try {
        isDir = (await fs.stat(folderPath)).isDirectory();
      } catch { /* folder chưa tồn tại */ }
      if (!isDir) {
        // Shop trong profiles nhưng chưa tạo folder → summary rỗng (chỉ khi includeEmptyProfiles)
        if (opts?.includeEmptyProfiles) {
          summaries.push({
            owner: username, folder: folderName,
            pending: 0, success: 0, fail: 0, total: 0,
            lastActivityMs: 0, cover: null, todayCount: 0, yesterdayCount: 0,
          });
        }
        return;
      }

      const [pending, success, fail] = await Promise.all([
        dirStats(folderPath),
        dirStats(path.join(folderPath, "Success")),
        dirStats(path.join(folderPath, "Fail")),
      ]);
      // Giữ thứ tự ưu tiên cũ: file mới nhất của pending → Success → Fail, cái nào ra ảnh trước thì lấy.
      let cover: string | null = null;
      for (const d of [pending, success, fail]) {
        if (d.newest && (cover = await coverOf(folderPath, d.newest, d.mtimeMs))) break;
      }

      summaries.push({
        owner: username,
        folder: folderName,
        pending: pending.count,
        success: success.count,
        fail: fail.count,
        total: pending.count + success.count + fail.count,
        lastActivityMs: Math.max(pending.mtimeMs, success.mtimeMs, fail.mtimeMs),
        cover,
        todayCount: 0,
        yesterdayCount: 0,
      });
    }));
  }

  // Đếm listing đăng thành công hôm nay / hôm qua theo mốc ngày GMT-7 (cố định)
  // từ bảng history (finished_at = thời điểm hoàn tất thật).
  const TZ = -7 * 60 * 60 * 1000; // GMT-7
  const startToday = Math.floor((Date.now() + TZ) / 86_400_000) * 86_400_000 - TZ;
  const startYesterday = startToday - 86_400_000;
  const endToday = startToday + 86_400_000;
  const [todayCounts, yestCounts] = await Promise.all([
    historyStore.countByFolder({ fromMs: startToday, toMs: endToday, status: "success" }),
    historyStore.countByFolder({ fromMs: startYesterday, toMs: startToday, status: "success" }),
  ]);
  for (const s of summaries) {
    s.todayCount = todayCounts[s.folder] ?? 0;
    s.yesterdayCount = yestCounts[s.folder] ?? 0;
  }

  summaries.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return summaries;
};

const STATUS_TO_SUBDIR: Record<ListingStatus, string> = {
  pending: "",
  success: "Success",
  fail: "Fail",
};

/**
 * Resolve absolute path từ id "owner::folder/status/file". Validate để chống
 * path traversal và phải match đúng baseDir của owner.
 */
export const resolveListingPath = async (
  id: string
): Promise<{
  owner: string;
  folder: string;
  status: ListingStatus;
  file: string;
  full: string;
  baseDir: string;
} | null> => {
  const [owner, rest] = id.split("::");
  if (!owner || !rest) return null;

  const parts = rest.split("/");
  if (parts.length !== 3) return null;
  const [folder, statusRaw, file] = parts;

  let status: ListingStatus;
  if (statusRaw === "_") status = "pending";
  else if (statusRaw === "success") status = "success";
  else if (statusRaw === "fail") status = "fail";
  else return null;

  if (folder.includes("..") || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return null;
  }
  if (!file.toLowerCase().endsWith(".json")) return null;

  const allDirs = await getAllUserDirs();
  // owner trong id có thể là dạng merged "a,b,c" (do dedup baseDir) hoặc single "a".
  // Thử direct equality trước, sau đó fallback substring includes.
  const dir =
    allDirs.find((d) => d.username === owner) ||
    allDirs.find((d) => d.username.split(",").includes(owner));
  if (!dir) return null;

  const subdir = STATUS_TO_SUBDIR[status];
  const full = subdir
    ? path.join(dir.baseSheinAutoDir, folder, subdir, file)
    : path.join(dir.baseSheinAutoDir, folder, file);

  return { owner, folder, status, file, full, baseDir: dir.baseSheinAutoDir };
};

// ── HUB sản phẩm (kho chung, ngoài baseDir user) ───────────────────
export interface HubItem {
  niche?: string | null;
  addedBy?: string | null;
  addedAt?: number | null;
  id: string; // = filename (unique trong hubDir)
  file: string;
  title: string;
  image: string | null;
  url: string | null;
  priceRange: { min: number; max: number; currency: string } | null;
  variantCount: number;
  colorCount: number;
  sizeCount: number;
  scrapedAt: string | null;
  mtimeMs: number;
  /** Số shop (distinct) sản phẩm này đã được list lên + tên shop + lần list gần nhất. */
  listedCount: number;
  listedShops: string[];
  lastListedMs: number;
}

// Meta Hub PER-PRODUCT (sidecar <hubfile>.hubmeta.json) thay cho __hub_meta.json global.
// Lý do: Hub dùng CHUNG qua LAN (4 máy) → 1 file global bị 4 máy ghi đè lẫn nhau. Sidecar
// mỗi sp 1 file → mỗi lượt list chỉ chạm file của sp đó → gần như không bao giờ đụng.
const HUB_META_SUFFIX = ".hubmeta.json";
const OLD_HUB_META = "__hub_meta.json";
export const isHubMetaFile = (f: string) => f.endsWith(HUB_META_SUFFIX) || f === OLD_HUB_META;
const metaPathOf = (file: string) => path.join(config.hubDir, file + HUB_META_SUFFIX);
interface HubMetaEntry { shops: string[]; lastAt: number; }

const readOneMeta = async (file: string): Promise<HubMetaEntry | null> => {
  try {
    const p = metaPathOf(file);
    if (!(await fs.pathExists(p))) return null;
    return JSON.parse(await fs.readFile(p, "utf-8")) as HubMetaEntry;
  } catch { return null; }
};
// Ghi ATOMIC: temp + rename → máy khác không đọc trúng file ghi dở.
const writeOneMeta = async (file: string, entry: HubMetaEntry): Promise<void> => {
  await fs.ensureDir(config.hubDir);
  const p = metaPathOf(file);
  const tmp = `${p}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry), "utf-8");
  await fs.move(tmp, p, { overwrite: true });
};

/** Ghi nhận hub file đã list sang shop (gộp distinct). Mỗi sp ghi sidecar riêng → an toàn đa máy. */
export const recordHubListings = async (fileToShops: Record<string, string[]>, nowMs: number): Promise<void> => {
  for (const [file, shops] of Object.entries(fileToShops)) {
    const cur = (await readOneMeta(file)) || { shops: [], lastAt: 0 };
    const set = new Set(cur.shops);
    for (const s of shops) set.add(s);
    await writeOneMeta(file, { shops: [...set], lastAt: nowMs });
  }
};

/** Xoá sidecar meta của các hub file đã bị xoá. */
export const removeHubMeta = async (files: string[]): Promise<void> => {
  for (const f of files) await fs.remove(metaPathOf(f)).catch(() => {});
};

/**
 * Chỉ mục Hub trong RAM: mỗi lần gọi chỉ `stat`, và CHỈ parse lại file có chữ ký (mtime+size của
 * file JSON + mtime sidecar meta) thay đổi. Trước đây mỗi lần gọi parse lại đủ ~4500 file/63MB,
 * mỗi file ĐỌC 2 LẦN → ~2.7s và khoá event loop tới ~600ms liền (JSON.parse đồng bộ) → cả server
 * khựng khi mở tab Hub/Ngách. Không cần hook xoá cache: thêm/xoá file đổi readdir, list sang shop
 * đổi mtime sidecar → tự bắt được.
 * ponytail: cache sống trong tiến trình; nhiều máy dùng chung HUB_DIR vẫn đúng vì so theo mtime.
 */
const hubIndex = new Map<string, { sig: string; item: HubItem | null }>();
let hubInflight: Promise<HubItem[]> | null = null;
const HUB_BATCH = 100; // nhường event loop giữa các lô → lần quét lạnh không khoá server liền mạch

/** Quét toàn bộ sản phẩm trong Hub (config.hubDir). Người gọi đồng thời dùng chung 1 lần quét. */
export const scanHub = (): Promise<HubItem[]> =>
  (hubInflight ??= scanHubIndexed().finally(() => { hubInflight = null; }));

const scanHubIndexed = async (): Promise<HubItem[]> => {
  const dir = config.hubDir;
  if (!(await fs.pathExists(dir))) { hubIndex.clear(); return []; }
  const all = await fs.readdir(dir);
  const metas = new Set(all.filter(isHubMetaFile));
  const files = all.filter((f) => f.toLowerCase().endsWith(".json") && !isHubMetaFile(f));
  const alive = new Set(files);
  for (const k of hubIndex.keys()) if (!alive.has(k)) hubIndex.delete(k);

  const out: HubItem[] = [];
  for (let i = 0; i < files.length; i += HUB_BATCH) {
    const batch = await Promise.all(files.slice(i, i + HUB_BATCH).map((f) => hubEntry(dir, f, metas)));
    for (const it of batch) if (it) out.push(it);
    await new Promise((r) => setImmediate(r));
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const hubEntry = async (dir: string, f: string, metas: Set<string>): Promise<HubItem | null> => {
  const stat = await fs.stat(path.join(dir, f)).catch(() => null);
  if (!stat) return null;
  const metaStat = metas.has(f + HUB_META_SUFFIX) ? await fs.stat(metaPathOf(f)).catch(() => null) : null;
  const sig = `${stat.mtimeMs}:${stat.size}|${metaStat?.mtimeMs ?? 0}`;
  const hit = hubIndex.get(f);
  if (hit && hit.sig === sig) return hit.item;
  const item = await buildHubItem(dir, f, stat);
  hubIndex.set(f, { sig, item });
  return item;
};

const buildHubItem = async (dir: string, f: string, stat: fs.Stats): Promise<HubItem | null> => {
      const raw = await fs.readJson(path.join(dir, f)).catch(() => null);
      if (!raw) return null;
      const card = await parseListingFile(path.join(dir, f), "hub", "hub", "success", { stat, data: raw });
      if (!card) return null;
      const m = await readOneMeta(f);
      return {
        id: f,
        file: f,
        title: card.title,
        image: card.image,
        url: typeof raw?.url === "string" ? raw.url : null,
        priceRange: card.priceRange,
        variantCount: card.variantCount,
        colorCount: card.colorCount,
        sizeCount: card.sizeCount,
        scrapedAt: card.scrapedAt,
        mtimeMs: card.mtimeMs,
        niche: card.niche ?? null,
        addedBy: raw?._addedBy ?? null,
        addedAt: raw?._addedAt ?? null,
        listedCount: m ? m.shops.length : 0,
        listedShops: m ? m.shops : [],
        lastListedMs: m ? m.lastAt : 0,
      } as HubItem;
};

/** Đường dẫn tuyệt đối 1 file hub (guard traversal). null nếu tên không hợp lệ. */
export const resolveHubFile = (file: string): string | null => {
  if (!file || /[\/\\]|\.\./.test(file) || !file.toLowerCase().endsWith(".json") || isHubMetaFile(file)) return null;
  return path.join(config.hubDir, file);
};
