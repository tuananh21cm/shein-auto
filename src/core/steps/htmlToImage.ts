import nodeHtmlToImage from "node-html-to-image";
import axios from "axios";

/**
 * Tải 1 ảnh remote → data URI base64. Dùng khi render HTML→ảnh: ảnh SHEIN bị chặn hotlink
 * từ Chrome headless (Cloudflare/referer) → nếu để `<img src=URL>` thì ảnh KHÔNG load
 * (banner trắng/timeout). Tải bằng Node (kèm Referer) rồi nhúng base64 → render khỏi cần mạng.
 * Trả null nếu tải lỗi.
 */
export async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "https://us.shein.com/",
      },
    });
    const mime = (res.headers["content-type"] as string) || "image/jpeg";
    const b64 = Buffer.from(res.data).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/** Tải nhiều ảnh → data URI song song; bỏ ảnh tải lỗi (giữ thứ tự ảnh tải được). */
export async function fetchImagesAsDataUris(urls: string[]): Promise<string[]> {
  const out = await Promise.all(urls.map(fetchAsDataUri));
  return out.filter((u): u is string => !!u);
}

/**
 * Args Chromium ổn định cho render HTML→ảnh (node-html-to-image dùng puppeteer).
 * Giảm crash launch + tránh treo do /dev/shm nhỏ.
 */
const STABLE_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * Render HTML → file PNG AN TOÀN. Dùng chung cho banner / color showcase / size guide.
 *
 * - Luôn pass STABLE_ARGS để Chromium con ổn định.
 * - Bọc timeout cứng: render nạp ảnh REMOTE (SHEIN) có thể treo → quá hạn thì reject
 *   để caller bắt và bỏ qua (ảnh marketing là phụ), KHÔNG để treo cả pipeline.
 *
 * Lỗi luôn ném ra dưới dạng rejected Promise (caller phải try/catch) — không bao giờ
 * crash process. Mọi 'error' event lạ của puppeteer được chặn ở handler global (index.ts).
 */
export async function renderHtmlToImage(opts: {
  output: string;
  html: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
}): Promise<void> {
  const { output, html, viewport, timeoutMs = 40_000 } = opts;
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`renderHtmlToImage quá hạn ${timeoutMs}ms (ảnh remote chậm/chặn)`)),
      timeoutMs
    );
  });
  const task = nodeHtmlToImage({
    output,
    html,
    puppeteerArgs: {
      args: STABLE_ARGS,
      ...(viewport ? { defaultViewport: viewport } : {}),
    },
  });
  try {
    await Promise.race([task, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
