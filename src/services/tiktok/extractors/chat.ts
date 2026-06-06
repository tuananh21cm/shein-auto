import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

/**
 * Bóc thống kê Customer messages (chat IM với khách) — KHÔNG cần vào trang /chat
 * (dễ lỗi khi shop_id sai). Lấy từ endpoint fire sẵn trên trang message center:
 * - shop_im/get_shop_live_metrics → unread_count (tin mới/chưa đọc), queue_length (chờ rep).
 * - helpdesk/unread_msg/get → Count (tin từ TikTok support).
 */
export function extractChat(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  const im = caps.find((c) => /shop_im\/shop\/user\/get_shop_live_metrics/.test(c.url));
  if (im) {
    const d = im.body?.data ?? im.body;
    const m0 = d?.shop_live_metrics?.[0];
    if (m0) {
      const unread = toNum(m0.unread_count);
      const queue = toNum(m0.queue_length);
      if (unread !== null) out.push({ key: "chat_unread", valueNum: unread, unit: "count" });
      if (queue !== null) out.push({ key: "chat_queue", valueNum: queue, unit: "count" });
    }
  }

  const hd = caps.find((c) => /helpdesk\/unread_msg\/get/.test(c.url));
  if (hd) {
    const d = hd.body?.data ?? hd.body;
    const n = toNum(d?.Count);
    if (n !== null) out.push({ key: "helpdesk_unread", valueNum: n, unit: "count" });
  }

  return out;
}
