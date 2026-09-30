import nodeHtmlToImage from "node-html-to-image";
import axios from "axios";

/**
 * Tải 1 ảnh remote → data URI base64. Dùng khi render HTML→ảnh: ảnh SHEIN bị chặn hotlink
 * từ Chrome headless (Cloudflare/referer) → nếu để `<img src=URL>` thì ảnh KHÔNG load
 * (banner trắng/timeout). Tải bằng Node (kèm Referer) rồi nhúng base64 → render khỏi cần mạng.
 * Trả null nếu tải lỗi.
 */
export async function fetchAsDataUri(url: string): Promise<string | null> {
  // Lỗi mạng chập chờn (ECONNRESET khi 6 listing cùng kéo ảnh) → thử lại, đừng bỏ ảnh ngay.
  // Trước đây catch nuốt sạch lỗi nên log chỉ nói "0/15 ảnh" mà không biết vì sao.
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
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
    } catch (e: any) {
      last = e?.code || e?.response?.status || e?.message || String(e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt + Math.random() * 400));
    }
  }
  console.warn(`⚠️ tải ảnh hỏng sau 3 lần (${last}): ${url.slice(0, 90)}`);
  return null;
}

/**
 * Tải nhiều ảnh → data URI; bỏ ảnh tải lỗi (giữ thứ tự ảnh tải được).
 *
 * Giới hạn 4 ảnh một lúc: bắn cả 15 request song song × 6 listing chạy cùng lúc là 90 kết
 * nối tới cùng CDN SHEIN — đó là lúc ECONNRESET nổ hàng loạt và banner mất sạch ảnh.
 */
export async function fetchImagesAsDataUris(urls: string[]): Promise<string[]> {
  const out: (string | null)[] = new Array(urls.length).fill(null);
  const LIMIT = 4;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) out[i] = await fetchAsDataUri(urls[i]);
  };
  await Promise.all(Array.from({ length: Math.min(LIMIT, urls.length) }, worker));
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
