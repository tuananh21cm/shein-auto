import axios from "axios";

/**
 * CapSolver — giải captcha ảnh chữ (ImageToText / OCR). Dùng cho verification code
 * ở trang login 4Seller (ảnh base64 chữ-số méo). Cần CAPSOLVER_API_KEY trong .env.
 * Doc: https://docs.capsolver.com/guide/recognition/ImageToTextTask.html
 */
const API = "https://api.capsolver.com";

/**
 * Giải 1 ảnh captcha base64 → text.
 * @param base64 chuỗi base64 (KHÔNG có tiền tố "data:image/...;base64,").
 * @param opts.module  preset OCR ("common" mặc định).
 * @param opts.caseSensitive  true = phân biệt hoa/thường.
 */
export async function solveImageCaptcha(
  base64: string,
  opts: { module?: string; caseSensitive?: boolean } = {}
): Promise<string> {
  const key = process.env.CAPSOLVER_API_KEY;
  if (!key) throw new Error("Thiếu CAPSOLVER_API_KEY trong .env");
  const body = base64.replace(/^data:image\/\w+;base64,/, "");

  const res = await axios.post(
    `${API}/createTask`,
    {
      clientKey: key,
      task: {
        type: "ImageToTextTask",
        body,
        module: opts.module ?? "common",
        case: opts.caseSensitive ?? true,
      },
    },
    { timeout: 30000 }
  );

  const d = res.data;
  if (d?.errorId && d.errorId !== 0) {
    throw new Error(`CapSolver lỗi: ${d.errorCode || ""} ${d.errorDescription || ""}`.trim());
  }
  const text = d?.solution?.text;
  if (!text) throw new Error(`CapSolver không trả text (status=${d?.status})`);
  return String(text).trim();
}
