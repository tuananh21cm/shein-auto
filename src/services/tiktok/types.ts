/** Một response JSON nội bộ TikTok seller center đã hứng được. */
export interface Capture {
  url: string;
  status: number;
  body: any;
}

/** Một chỉ số chuẩn hoá (long-format). */
export interface Metric {
  key: string;                 // 'gmv', 'orders', 'conversion_rate', 'alert_count'...
  valueNum?: number | null;
  valueText?: string | null;
  unit?: string | null;        // 'USD', '%', 'count'...
}

/** Kết quả bóc của 1 route. */
export interface RouteMetrics {
  route: string;
  metrics: Metric[];
  ok: boolean;
  error?: string;
}

/** Khai báo 1 route trong registry. */
export interface RouteDef {
  key: string;
  url: string;
  waitForSelector?: string;
  settleMs?: number;
  /** Capture-first: KHÔNG chờ giải captcha (data thường fire trước overlay). Cho route
   *  analytics dính captcha mỗi lần — load, hứng data, đóng nhanh. Mặc định false. */
  skipCaptcha?: boolean;
  /** Regex (source) endpoint chỉ số chính. Nếu set → poll tới khi capture được endpoint
   *  này (hoặc hết settleMs) rồi mới bóc — cho API fire muộn. */
  waitForEndpoint?: string;
  /** Bóc chỉ số từ captures của route. Thuần, không phụ thuộc browser. */
  extractor: (caps: Capture[]) => Metric[];
}

export type CrawlStatus = "ok" | "partial" | "login_required" | "error";

export interface CrawlSnapshot {
  runId: number;
  runDate: string;             // 'YYYY-MM-DD'
  startedAt: string;           // ISO
  finishedAt: string;          // ISO
  status: CrawlStatus;
  routes: RouteMetrics[];
  notes?: string;
}

export interface AnalysisAlert {
  severity: "high" | "medium" | "low";
  title: string;
  detail?: string;
  action?: string;
}
export interface AnalysisTodo {
  priority: number;
  task: string;
  why?: string;
}
export interface AnalysisResult {
  summary: string;
  alerts: AnalysisAlert[];
  strengths: string[];
  weaknesses: string[];
  todos: AnalysisTodo[];
}
