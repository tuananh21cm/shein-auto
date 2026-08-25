import type { Capture, Metric } from "../types";
import { extractDashboard } from "./_dashboard";

/**
 * Bóc chỉ số quản lý Return & Refund (trang /order/return) — xác minh discovery 2026-06-06.
 * reverse/dashboard/get → respond_within_24h, auto_approved_7d, can_be_appealed,
 * disputes_awaiting_response (cùng cấu trúc dashboard_columns như order).
 */
export function extractReturns(caps: Capture[]): Metric[] {
  return extractDashboard(caps, /reverse\/dashboard\/get/, "return_");
}
