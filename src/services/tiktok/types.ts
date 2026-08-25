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

/** Snapshot view/đơn của 1 listing tại 1 ngày cào (nguồn: product/local/products/list). */
export interface ListingViewRow {
  productId: string;
  productName: string;
  /** last_28days_pv — cửa sổ TRƯỢT 28 ngày (không phải view trong ngày). */
  pv28d: number;
  orders28d: number;
  gmv28d: number | null;
  salesTotal: number | null;
  stock: number | null;
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
  /** Nếu set → bóc thêm snapshot per-listing, crawler lưu vào bảng listing_views
   *  (time-series view từng SP để diff hôm qua / 7 ngày). */
  listingExtractor?: (caps: Capture[]) => ListingViewRow[];
  /** Tương tác thêm SAU khi endpoint chính fire, TRƯỚC khi bóc (vd: click trang 2
   *  phân trang để hứng đủ SP). Lỗi trong interact không làm fail route. */
  interact?: (page: any, bus: { snapshot(): Capture[] }, log: (m: string) => void) => Promise<void>;
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

export type HealthStatus = "good" | "warning" | "critical";

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
/** Chấm điểm sức khỏe 1 mảng (Sức khỏe, Vận hành, Doanh số, Marketing, Sản phẩm, Inbox). */
export interface AnalysisArea {
  area: string;
  status: HealthStatus;
  note: string;
}
/** Xu hướng đáng kể so với hôm qua. */
export interface AnalysisTrend {
  label: string;
  direction: "up" | "down";
  note: string;
}
export interface AnalysisResult {
  overallStatus: HealthStatus;
  summary: string;
  areas: AnalysisArea[];
  trends: AnalysisTrend[];
  alerts: AnalysisAlert[];
  todos: AnalysisTodo[];
}
