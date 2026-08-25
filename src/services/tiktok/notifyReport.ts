import axios from "axios";
import type { CrawlSnapshot, AnalysisResult, HealthStatus } from "./types";

const TG_API = "https://api.telegram.org";

const ST_ICON: Record<HealthStatus, string> = { good: "🟢", warning: "🟡", critical: "🔴" };
const ST_WORD: Record<HealthStatus, string> = { good: "TỐT", warning: "CẦN CHÚ Ý", critical: "NGHIÊM TRỌNG" };
const SEV_ICON: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

function short(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Render report cho Telegram: plain text gọn, emoji dẫn mắt, KHÔNG markdown/bảng.
 * Chỉ nêu trọng tâm — status từng mảng + cảnh báo + việc cần làm (rút ngắn).
 */
export function renderTelegram(snap: CrawlSnapshot, a: AnalysisResult, reportPath?: string): string {
  const L: string[] = [];
  L.push(`${ST_ICON[a.overallStatus]} TIKTOK SHOP · ${snap.runDate} · ${ST_WORD[a.overallStatus]}`);
  if (a.summary) {
    L.push("");
    L.push(short(a.summary, 260));
  }

  if (a.areas?.length) {
    L.push("");
    L.push("━━━ SỨC KHỎE ━━━");
    for (const ar of a.areas) L.push(`${ST_ICON[ar.status] ?? "⚪"} ${ar.area} · ${short(ar.note, 95)}`);
  }

  if (a.trends?.length) {
    L.push("");
    L.push("━━━ 📈 XU HƯỚNG ━━━");
    for (const t of a.trends.slice(0, 5)) L.push(`${t.direction === "up" ? "↑" : "↓"} ${t.label}: ${short(t.note, 70)}`);
  }

  if (a.alerts?.length) {
    L.push("");
    L.push("━━━ 🚨 CẢNH BÁO ━━━");
    for (const al of a.alerts.slice(0, 5))
      L.push(`${SEV_ICON[al.severity] ?? "•"} ${short(al.title, 75)}${al.action ? `\n   → ${short(al.action, 90)}` : ""}`);
  }

  if (a.todos?.length) {
    L.push("");
    L.push("━━━ ✅ VIỆC CẦN LÀM ━━━");
    [...a.todos]
      .sort((x, y) => x.priority - y.priority)
      .slice(0, 6)
      .forEach((t, i) => L.push(`${i + 1}. ${short(t.task, 95)}`));
  }

  if (reportPath) {
    L.push("");
    L.push(`📄 ${reportPath}`);
  }
  return L.join("\n");
}

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
