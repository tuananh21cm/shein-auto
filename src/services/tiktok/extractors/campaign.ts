import type { Capture, Metric } from "../types";
import { toNum } from "../deepFind";

function find(caps: Capture[], re: RegExp): any | undefined {
  const c = caps.find((x) => re.test(x.url));
  if (!c) return undefined;
  return c.body?.data ?? c.body;
}

/**
 * Bóc chỉ số Campaign (trang /promotion/campaign-tools/all) — xác minh discovery
 * 2026-06-06. Capture-first.
 *
 * - campaign/summary_info: số campaign ĐANG tham gia (cộng các scene).
 * - parents_campaigns/list → total_count: số campaign KHẢ DỤNG để đăng ký.
 * - register_task/statistic → recommend: số campaign MỚI được gợi ý.
 */
export function extractCampaign(caps: Capture[]): Metric[] {
  const out: Metric[] = [];

  const si = find(caps, /campaign\/summary_info/);
  if (si && Array.isArray(si.summary_info)) {
    const joined = si.summary_info.reduce((a: number, s: any) => a + (toNum(s.campaign_count) ?? 0), 0);
    out.push({ key: "campaigns_joined", valueNum: joined, unit: "count" });
  }

  const pc = find(caps, /parents_campaigns\/list/);
  if (pc) {
    const tc = toNum(pc.total_count);
    if (tc !== null) out.push({ key: "campaigns_available", valueNum: tc, unit: "count" });
  }

  const rt = find(caps, /register_task\/statistic/);
  if (rt && Array.isArray(rt.statistic_infos)) {
    let rec = 0;
    let found = false;
    for (const s of rt.statistic_infos) {
      const n = s?.recommend_static_info?.new_recommend_count;
      if (n !== undefined) {
        found = true;
        rec += toNum(n) ?? 0;
      }
    }
    if (found) out.push({ key: "campaigns_new_recommend", valueNum: rec, unit: "count" });
  }

  return out;
}
