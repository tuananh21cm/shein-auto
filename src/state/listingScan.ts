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

/**
 * Dựng ListingCard từ JSON ĐÃ đọc sẵn. Tách khỏi parseListingFile để caller nào đã có nội dung
 * file trong tay (scanHub) khỏi phải đọc lại — Hub nằm trên share LAN nên mỗi lần đọc thừa là
 * một round-trip SMB, nhân với vài nghìn sản phẩm.
 */
const buildListingCard = async (
  data: any,
  mtimeMs: number,
  filePath: string,
  owner: string,
  folder: string,
  status: ListingStatus
): Promise<ListingCard | null> => {
  try {
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
      mtimeMs,
      errorMessage,
      screenshotUrl,
      niche: deriveNiche(`${data?.category || ""} ${typeof data.product_name === "string" ? data.product_name : ""}`),
    };
  } catch {
    return null;
  }
};

const parseListingFile = async (
  filePath: string,
  owner: string,
  folder: string,
  status: ListingStatus
): Promise<ListingCard | null> => {
  try {
    const stat = await fs.stat(filePath);
    const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return await buildListingCard(data, stat.mtimeMs, filePath, owner, folder, status);
  } catch {
    return null;
  }
};

const listJsonsIn = async (dir: string): Promise<string[]> => {
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.toLowerCase().endsWith(".json"));
};

const countJsons = async (dir: string): Promise<{ count: number; mtimeMs: number }> => {
  if (!(await fs.pathExists(dir))) return { count: 0, mtimeMs: 0 };
  try {
    const entries = await fs.readdir(dir);
    const jsons = entries.filter((f) => f.toLowerCase().endsWith(".json"));
    let mtimeMs = 0;
    for (const f of jsons) {
      try {
        const s = await fs.stat(path.join(dir, f));
        if (s.mtimeMs > mtimeMs) mtimeMs = s.mtimeMs;
      } catch {
        // ignore
      }
    }
    return { count: jsons.length, mtimeMs };
  } catch {
    return { count: 0, mtimeMs: 0 };
  }
};

const pickCoverImage = async (folderPath: string): Promise<string | null> => {
  for (const dir of [folderPath, path.join(folderPath, "Success"), path.join(folderPath, "Fail")]) {
    if (!(await fs.pathExists(dir))) continue;
    try {
      const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
      let newest: { file: string; mtimeMs: number } | null = null;
      for (const f of files) {
        const s = await fs.stat(path.join(dir, f));
        if (!newest || s.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: s.mtimeMs };
      }
      if (!newest) continue;
      const raw = await fs.readFile(path.join(dir, newest.file), "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.product_images) && data.product_images.length > 0) {
        return data.product_images[0];
      }
      if (Array.isArray(data.variant_images) && data.variant_images.length > 0) {
        const urls = Object.values(data.variant_images[0])[0];
        if (Array.isArray(urls) && urls.length > 0) return urls[0] as string;
      }
    } catch {
      // ignore
    }
  }
  return null;
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
      for (const file of files) {
        const card = await parseListingFile(path.join(dir, file), username, folderName, status);
        if (card) cards.push(card);
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

    for (const folderName of folders) {
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
        continue;
      }

      const [pending, success, fail] = await Promise.all([
        countJsons(folderPath),
        countJsons(path.join(folderPath, "Success")),
        countJsons(path.join(folderPath, "Fail")),
      ]);
      const cover = await pickCoverImage(folderPath);

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
    }
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
  invalidateHubCache();
};

/** Xoá sidecar meta của các hub file đã bị xoá. */
export const removeHubMeta = async (files: string[]): Promise<void> => {
  for (const f of files) await fs.remove(metaPathOf(f)).catch(() => {});
  invalidateHubCache();
};

/** Quét toàn bộ sản phẩm trong Hub (config.hubDir). Tái dùng parseListingFile. */
/**
 * Cache kết quả scanHub. Hub nằm trên share LAN nên mỗi lần quét là vài nghìn round-trip SMB
 * (~20s với 4.4k sp) — mà UI gọi lại MỖI lần bấm sang tab Hub, và màn Ngách cũng gọi.
 *
 * Khoá cache = (số entry trong thư mục, mtime thư mục). readdir + stat thư mục gần như miễn phí
 * (~0ms) nên kiểm tra rẻ hơn quét lại nhiều bậc. Thêm/xoá sản phẩm hay ghi sidecar meta (kể cả
 * từ máy khác trong đội) đều đổi mtime thư mục → cache tự hết hiệu lực.
 */
let _hubCache: { dir: string; count: number; dirMtimeMs: number; items: HubItem[] } | null = null;

/**
 * Vứt cache scanHub. Cache tự hết hiệu lực theo mtime thư mục, nhưng ghi ĐÈ một sidecar đã có
 * thì không chắc đổi mtime thư mục — nên mọi đường ghi trong process gọi thẳng hàm này.
 */
export const invalidateHubCache = (): void => { _hubCache = null; };

/** Số file đọc song song khi quét Hub. Bung hết vài nghìn request cùng lúc làm nghẽn SMB. */
const HUB_SCAN_CONCURRENCY = 32;

/** Quét toàn bộ sản phẩm trong Hub (config.hubDir). Tái dùng buildListingCard. */
export const scanHub = async (): Promise<HubItem[]> => {
  const dir = config.hubDir;
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const dirMtimeMs = await fs.stat(dir).then((st) => st.mtimeMs).catch(() => 0);
  // dir nằm trong khoá cache: toggle Hub tổng đổi config.hubDir lúc chạy, thiếu nó sẽ trả
  // nhầm data của thư mục trước đó.
  if (_hubCache && _hubCache.dir === dir && _hubCache.count === entries.length && _hubCache.dirMtimeMs === dirMtimeMs) {
    return _hubCache.items;
  }

  const files = entries.filter((f) => f.toLowerCase().endsWith(".json") && !isHubMetaFile(f));
  // Sidecar meta rất thưa (chỉ sp đã list mới có). readdir đã cầm sẵn danh sách nên chỉ đọc
  // đúng file tồn tại — trước đây gọi readOneMeta cho MỌI sp, phần lớn tốn 1 round-trip để
  // nhận về ENOENT.
  const metaNames = new Set(entries.filter((f) => f.endsWith(HUB_META_SUFFIX)));

  const items: (HubItem | null)[] = new Array(files.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      try {
        const full = path.join(dir, f);
        const stat = await fs.stat(full);
        // Đọc ĐÚNG 1 lần rồi dùng chung cho card lẫn url/addedBy.
        const raw = JSON.parse(await fs.readFile(full, "utf-8"));
        const card = await buildListingCard(raw, stat.mtimeMs, full, "hub", "hub", "success");
        if (!card) continue;
        const m = metaNames.has(f + HUB_META_SUFFIX) ? await readOneMeta(f) : null;
        items[i] = {
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
      } catch {
        // file hỏng/đang ghi dở → bỏ qua, giữ nguyên null
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HUB_SCAN_CONCURRENCY, files.length) }, () => worker())
  );

  const out = items
    .filter((x): x is HubItem => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  _hubCache = { dir, count: entries.length, dirMtimeMs, items: out };
  return out;
};

/** Đường dẫn tuyệt đối 1 file hub (guard traversal). null nếu tên không hợp lệ. */
export const resolveHubFile = (file: string): string | null => {
  if (!file || /[\/\\]|\.\./.test(file) || !file.toLowerCase().endsWith(".json") || isHubMetaFile(file)) return null;
  return path.join(config.hubDir, file);
};
