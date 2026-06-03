import axios from "axios";
import { config } from "../../config";

const TG_API = "https://api.telegram.org";

const escape = (s: string): string =>
  s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (m) => `\\${m}`);

const send = async (text: string, parseMode: "MarkdownV2" | "HTML" = "MarkdownV2"): Promise<void> => {
  const { telegramBotToken: token, telegramChatId: chatId } = config;
  if (!token || !chatId) return; // notification tắt

  try {
    await axios.post(
      `${TG_API}/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
  } catch (err: any) {
    console.warn("⚠️ Telegram notify thất bại:", err?.response?.data ?? err?.message ?? err);
  }
};

export const notifySuccess = async (params: {
  file: string;
  folder: string;
  profile: string;
  durationMs: number;
}): Promise<void> => {
  const seconds = Math.round(params.durationMs / 1000);
  const text =
    `*✅ Listing thành công*\n` +
    `Shop: \`${escape(params.profile)}\`\n` +
    `Folder: \`${escape(params.folder)}\`\n` +
    `File: \`${escape(params.file)}\`\n` +
    `Thời gian: \`${seconds}s\``;
  await send(text);
};

export const notifyFail = async (params: {
  file: string;
  folder: string;
  profile: string;
  errorMessage: string;
}): Promise<void> => {
  const msg = params.errorMessage.length > 500
    ? params.errorMessage.slice(0, 500) + "..."
    : params.errorMessage;
  const text =
    `*❌ Listing thất bại*\n` +
    `Shop: \`${escape(params.profile)}\`\n` +
    `Folder: \`${escape(params.folder)}\`\n` +
    `File: \`${escape(params.file)}\`\n` +
    `Lỗi: \`\`\`\n${escape(msg)}\n\`\`\``;
  await send(text);
};

export const notifyInfo = async (message: string): Promise<void> => {
  await send(`ℹ️ ${escape(message)}`);
};

export const notifyCaptcha = async (params: {
  context: string;
  profileId?: string;
  url?: string;
}): Promise<void> => {
  const text =
    `*⚠️ CAPTCHA SHEIN — cần giải thủ công*\n` +
    `Việc: \`${escape(params.context)}\`\n` +
    (params.profileId ? `Profile: \`${escape(params.profileId)}\`\n` : "") +
    (params.url ? `URL: ${escape(params.url.slice(0, 120))}\n` : "") +
    `👉 Mở cửa sổ Kiki, giải slider/click ảnh\\. Worker sẽ tự chạy tiếp khi xong\\.`;
  await send(text);
};
