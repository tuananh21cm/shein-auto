import axios from "axios";

const TG_API = "https://api.telegram.org";

/** Tách text thành các đoạn <= maxLen (ưu tiên cắt ở xuống dòng) cho giới hạn 4096 của Telegram. */
export function chunkText(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur ? cur.length + 1 : 0) + line.length > maxLen) {
      if (cur) chunks.push(cur);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface TiktokTgConfig {
  token: string;
  chatId: string;
}

/** Đọc cấu hình Telegram cho report TikTok: ưu tiên TIKTOK_TG_*, fallback TELEGRAM_*. */
export function tiktokTgConfig(): TiktokTgConfig | null {
  const token = process.env.TIKTOK_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TIKTOK_TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** Gửi report TikTok vào Telegram (plain text, tách đoạn nếu dài). Trả false nếu chưa cấu hình/lỗi. */
export async function sendTiktokReport(text: string, onLog?: (m: string) => void): Promise<boolean> {
  const cfg = tiktokTgConfig();
  if (!cfg) {
    onLog?.("Telegram chưa cấu hình (TIKTOK_TG_BOT_TOKEN/CHAT_ID) — bỏ gửi.");
    return false;
  }
  const chunks = chunkText(text);
  try {
    for (const chunk of chunks) {
      await axios.post(
        `${TG_API}/bot${cfg.token}/sendMessage`,
        { chat_id: cfg.chatId, text: chunk, disable_web_page_preview: true },
        { timeout: 10000 }
      );
    }
    onLog?.(`Đã gửi report lên Telegram (${chunks.length} tin nhắn).`);
    return true;
  } catch (e: any) {
    onLog?.("Gửi Telegram thất bại: " + (e?.response?.data?.description ?? e?.message ?? e));
    return false;
  }
}
