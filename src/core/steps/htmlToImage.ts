import axios from "axios";
import { chromium } from "playwright-core";

/**
 * Tải 1 ảnh remote → data URI base64. SHEIN chặn hotlink từ Chrome headless (Cloudflare/referer)
 * → `<img src=URL>` không load (ảnh trắng/timeout). Tải bằng Node kèm Referer rồi nhúng base64
 * → render khỏi cần mạng. Trả null nếu lỗi.
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

/** Tải nhiều ảnh → data URI song song; bỏ ảnh lỗi (giữ thứ tự tải được). */
export async function fetchImagesAsDataUris(urls: string[]): Promise<string[]> {
  const out = await Promise.all(urls.map(fetchAsDataUri));
  return out.filter((u): u is string => !!u);
}

const STABLE_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

/**
 * Render HTML → file PNG. Dùng playwright-core (đã có sẵn cho listing) thay node-html-to-image
 * → khỏi thêm dep bundle Chromium. Ảnh marketing là phụ: quá timeoutMs thì throw để caller
 * bỏ qua, KHÔNG treo pipeline. Ảnh remote nên nhúng base64 trước (fetchAsDataUri) để render offline.
 */
export async function renderHtmlToImage(opts: {
  output: string;
  html: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
}): Promise<void> {
  const { output, html, viewport, timeoutMs = 40_000 } = opts;
  const browser = await chromium.launch({ args: STABLE_ARGS });
  try {
    const page = await browser.newPage(viewport ? { viewport } : {});
    await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
    // Screenshot body (clip đúng nội dung render) — khớp hành vi node-html-to-image.
    await page.locator("body").screenshot({ path: output, timeout: timeoutMs });
  } finally {
    await browser.close().catch(() => {});
  }
}
