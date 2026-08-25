import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

// Category chính sách quan trọng (msg_category_type → slug). Map từ discovery 2026-06-06.
const POLICY_CATS: Record<string, string> = {
  "4000000": "violations",
  "6000000": "policies",
  "5000000": "appeals",
  "1400000": "account_updates",
};

/**
 * Bóc tín hiệu Inbox (trang /message/center) — phục vụ "không miss thông tin chính sách".
 * - pull_by_category_v2: số chưa đọc theo từng category (đặc biệt Violations/Policies/
 *   Appeals/Account updates) + tổng.
 * - v2/message/list: tiêu đề + brief của message đã load (để AI đọc nội dung & ra chiến thuật).
 */
export function extractMessages(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  // 1. Unread theo category — GOM từ MỌI lần pull_by_category_v2 fire (lấy count lớn nhất/category).
  const cats = new Map<string, number>();
  for (const c of caps) {
    if (!/pull_by_category_v2/.test(c.url)) continue;
    const d = c.body?.data ?? c.body;
    if (!Array.isArray(d?.list_details)) continue;
    for (const cat of d.list_details) {
      const key = String(cat.msg_category_type);
      const n = toNum(cat.new_message_count) ?? 0;
      cats.set(key, Math.max(cats.get(key) ?? 0, n));
    }
  }
  if (cats.size) {
    let total = 0;
    for (const [key, n] of cats) {
      total += n;
      const slug = POLICY_CATS[key];
      if (slug) out.push({ key: `unread_${slug}`, valueNum: n, unit: "count" });
    }
    out.push({ key: "unread_total", valueNum: total, unit: "count" });
  }

  // 2. Nội dung message — GOM từ MỌI lần message/list fire, dedup theo title (để AI đọc).
  const seen = new Set<string>();
  let idx = 0;
  for (const c of caps) {
    if (!/v2\/seller\/message\/list/.test(c.url)) continue;
    const d = c.body?.data ?? c.body;
    for (const m of d?.message ?? []) {
      if (!m?.title || seen.has(m.title) || idx >= 8) continue;
      seen.add(m.title);
      idx++;
      const status = m.read_status === 1 || m.read_status === true ? "read" : "unread";
      const brief = String(m.brief_content || "").slice(0, 90);
      out.push({ key: `msg_${idx}`, valueText: `[${status}] ${m.title}${brief ? " — " + brief : ""}` });
    }
  }

  return out;
}
