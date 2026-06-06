import { describe, it, expect } from "vitest";
import { extractHomepage } from "./homepage";
import { extractCompassOverview } from "./compassOverview";
import { extractShopOverview } from "./shopOverview";
import { extractPromotion } from "./promotion";
import { extractCampaign } from "./campaign";
import { extractMessages } from "./messages";
import { extractChat } from "./chat";
import { extractOrders } from "./orders";
import { extractReturns } from "./returns";
import type { Capture } from "../types";

// Fixtures dựa trên payload THẬT từ discovery 2026-06-05 (đã rút gọn).
const homepageCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v1/account/ahr/score?account_type=2",
    status: 200,
    body: { data: { score: 189 } },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/seller/growth_center/violation/overview/get",
    status: 200,
    body: {
      data: {
        violation_score: 0,
        has_new_violation: false,
        violation_points_v2: [
          { violation_type_key: "performance_overview_violation_type_order_fulfillment", count: 2 },
          { violation_type_key: "performance_overview_violation_type_service_metrics", count: 0 },
          { violation_type_key: "performance_overview_violation_type_policy_compliance", count: 1 },
          { violation_type_key: "performance_overview_violation_type_risk_fraud", count: 2 },
        ],
      },
    },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/pay/statement/stat/info?amount_stat_type=1",
    status: 200,
    body: { data: { to_settle_amount_stat: { amount: { amount: "831", currency: "USD" } } } },
  },
  {
    url: "https://seller-us.tiktok.com/api/fulfillment/na/order/list?aid=4068",
    status: 200,
    body: { data: { total_count: 303, main_orders: [] } },
  },
];

describe("extractHomepage (real fixtures)", () => {
  it("bóc AHR score", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "ahr_score")?.valueNum).toBe(189);
  });
  it("bóc violation score + tổng + critical + fulfillment", () => {
    const m = extractHomepage(homepageCaps);
    expect(m.find((x) => x.key === "violation_score")?.valueNum).toBe(0);
    expect(m.find((x) => x.key === "violation_total")?.valueNum).toBe(5);
    expect(m.find((x) => x.key === "violation_critical")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "violation_fulfillment")?.valueNum).toBe(2);
  });
  it("bóc số tiền chờ settle", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "to_settle_amount")?.valueNum).toBe(831);
  });
  it("bóc tổng đơn", () => {
    expect(extractHomepage(homepageCaps).find((m) => m.key === "orders_total")?.valueNum).toBe(303);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractHomepage([])).toEqual([]);
  });
});

// Fixture THẬT từ discovery 2026-06-05-phase2 (endpoint v3 overview stats, rút gọn 2 kỳ).
const overviewCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v3/insights/seller/shop/overview/performance/stats",
    status: 200,
    body: {
      data: {
        segments: [
          {
            time_descriptor: { granularity: "all" },
            timed_stats: [{ start: "2026-05-29", end: "2026-06-04", stats: { revenue: { amount: "179.94" }, main_order_cnt: 7 } }],
          },
          {
            time_descriptor: { granularity: "1D" },
            timed_stats: [
              { start: "2026-06-03", end: "2026-06-04", stats: { revenue: { amount: "52.39" }, main_order_cnt: 2 } },
              {
                start: "2026-06-04",
                end: "2026-06-05",
                stats: {
                  revenue: { amount: "46.71" },
                  gross_revenue: { amount: "48.2" },
                  refund_amount: { amount: "0" },
                  main_order_cnt: 2,
                  item_sold_cnt: 2,
                  product_page_view_cnt: 218,
                  product_page_visitor_cnt: "119",
                  review_cnt: 1,
                  conversion_rate: "0.0168",
                  video_content_revenue: { amount: "0" },
                },
              },
            ],
          },
        ],
      },
    },
  },
];

describe("extractShopOverview (real fixture — lấy kỳ 1D mới nhất)", () => {
  it("bóc revenue/orders/traffic/conversion của ngày mới nhất", () => {
    const m = extractShopOverview(overviewCaps);
    expect(m.find((x) => x.key === "revenue")?.valueNum).toBe(46.71);
    expect(m.find((x) => x.key === "orders")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "page_views")?.valueNum).toBe(218);
    expect(m.find((x) => x.key === "visitors")?.valueNum).toBe(119);
    expect(m.find((x) => x.key === "conversion_rate")?.valueNum).toBe(1.68);
    expect(m.find((x) => x.key === "period")?.valueText).toBe("2026-06-04→2026-06-05");
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractShopOverview([])).toEqual([]);
  });
});

// Fixture THẬT từ discovery 2026-06-06 (promotion route, rút gọn).
const promotionCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v1/promotion/get_summary",
    status: 200,
    body: { data: { quantity_info: [{ promotion_status: 2, quantity: 4 }, { promotion_status: 3, quantity: 0 }] } },
  },
  {
    url: "https://seller-us.tiktok.com/api/v4/insights/seller/shop/promotion/info",
    status: 200,
    body: {
      data: {
        promotions: [
          { promotion_tool: 6, info: { has_any_promotion_tool: true } },
          { promotion_tool: 1, info: { has_any_promotion_tool: true } },
          { promotion_tool: 2, info: { has_any_promotion_tool: false } },
        ],
      },
    },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/insights/seller/shop/promotion/period/stats",
    status: 200,
    body: {
      data: {
        segments: [
          {
            time_descriptor: { granularity: "7D" },
            timed_stats: [
              {
                stats_promotion_tools: [
                  { promotion_tools: 6, metrics: [{ stats_type_str: "REVENUE", stats: { amount: "179.94" } }] },
                  { promotion_tools: 3, metrics: [{ stats_type_str: "REVENUE", stats: { amount: "150.13" } }] },
                ],
              },
            ],
          },
        ],
      },
    },
  },
];

describe("extractPromotion (real fixture)", () => {
  it("bóc số promotion đang chạy/sắp tới + tool bật + doanh thu top", () => {
    const m = extractPromotion(promotionCaps);
    expect(m.find((x) => x.key === "promotions_ongoing")?.valueNum).toBe(4);
    expect(m.find((x) => x.key === "promotions_upcoming")?.valueNum).toBe(0);
    expect(m.find((x) => x.key === "promotion_tools_enabled")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "promotion_revenue_top_7d")?.valueNum).toBe(179.94);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractPromotion([])).toEqual([]);
  });
});

// Fixture THẬT từ discovery 2026-06-06 (campaign route, giá trị non-zero để test cộng).
const campaignCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v1/promotion/campaign/seller/campaign/summary_info",
    status: 200,
    body: { data: { summary_info: [{ campaign_count: 2, scene: 1 }, { campaign_count: 1, scene: 2 }] } },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/promotion/campaign/seller/parents_campaigns/list",
    status: 200,
    body: { data: { total_count: 6, campaigns_list: [] } },
  },
  {
    url: "https://seller-us.tiktok.com/api/v1/promotion/campaign/seller/register_task/statistic/get",
    status: 200,
    body: { data: { statistic_infos: [{ count: 0, scene: 1 }, { count: 0, scene: 9, recommend_static_info: { has_new_recommend: true, new_recommend_count: 3 } }] } },
  },
];

describe("extractCampaign (real fixture)", () => {
  it("bóc campaign đang tham gia + khả dụng + gợi ý mới", () => {
    const m = extractCampaign(campaignCaps);
    expect(m.find((x) => x.key === "campaigns_joined")?.valueNum).toBe(3);
    expect(m.find((x) => x.key === "campaigns_available")?.valueNum).toBe(6);
    expect(m.find((x) => x.key === "campaigns_new_recommend")?.valueNum).toBe(3);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractCampaign([])).toEqual([]);
  });
});

// Fixture THẬT từ discovery 2026-06-06 (message center, rút gọn).
const messageCaps: Capture[] = [
  {
    url: "https://seller-us.tiktok.com/api/v1/seller/message/pull_by_category_v2",
    status: 200,
    body: {
      data: {
        list_details: [
          { msg_category_type: -1000000, msg_category_type_name: "Your priority", new_message_count: 0 },
          { msg_category_type: 4000000, msg_category_type_name: "Violations", new_message_count: 1 },
          { msg_category_type: 6000000, msg_category_type_name: "Policies", new_message_count: 1 },
          { msg_category_type: 1400000, msg_category_type_name: "Account updates", new_message_count: 1 },
        ],
      },
    },
  },
  {
    url: "https://seller-us.tiktok.com/api/v2/seller/message/list",
    status: 200,
    body: {
      data: {
        total_count: 1,
        message: [
          { title: "Strengthened Enforcement for Inaccurate Tracking Information", brief_content: "What sellers need to do for accurate tracking", read_status: 0 },
        ],
      },
    },
  },
];

describe("extractMessages (real fixture)", () => {
  it("bóc unread theo category chính sách + tổng", () => {
    const m = extractMessages(messageCaps);
    expect(m.find((x) => x.key === "unread_violations")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "unread_policies")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "unread_account_updates")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "unread_total")?.valueNum).toBe(3);
  });
  it("bóc tiêu đề message đã load (để AI đọc)", () => {
    const m = extractMessages(messageCaps);
    const msg = m.find((x) => x.key === "msg_1");
    expect(msg?.valueText).toContain("Strengthened Enforcement");
    expect(msg?.valueText).toContain("[unread]");
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractMessages([])).toEqual([]);
  });
});

describe("extractChat (real fixture — customer messages)", () => {
  it("bóc unread + queue + helpdesk", () => {
    const caps: Capture[] = [
      {
        url: "https://seller-us.tiktok.com/api/v1/shop_im/shop/user/get_shop_live_metrics",
        status: 200,
        body: { data: { shop_live_metrics: [{ oec_shop_id: "7496308481964214528", unread_count: 3, queue_length: 1 }] } },
      },
      {
        url: "https://seller-us.tiktok.com/api/v1/proxy/seller/helpdesk/unread_msg/get",
        status: 200,
        body: { data: { Count: 2, Message: [] } },
      },
    ];
    const m = extractChat(caps);
    expect(m.find((x) => x.key === "chat_unread")?.valueNum).toBe(3);
    expect(m.find((x) => x.key === "chat_queue")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "helpdesk_unread")?.valueNum).toBe(2);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractChat([])).toEqual([]);
  });
});

describe("extractOrders (real fixture)", () => {
  const caps: Capture[] = [
    {
      url: "https://seller-us.tiktok.com/api/fulfillment/na/dashboard/get",
      status: 200,
      body: {
        data: {
          dashboard_columns: [
            { column_id: "100100", title_text: "Ship within 24 hours or less", order_count: 2 },
            { column_id: "100200", title_text: "Auto-canceling within 24 hours or less", order_count: 0 },
            { column_id: "100300", title_text: "Shipping overdue", order_count: 0 },
            { column_id: "100600", title_text: "Return/refund requested", order_count: 1 },
          ],
        },
      },
    },
    {
      url: "https://seller-us.tiktok.com/api/fulfillment/na/order/search_count",
      status: 200,
      body: { data: { count_map: { "101": 6, "1100": 1, "102": 26 } } },
    },
  ];
  it("bóc Action Needed theo title + đếm trạng thái", () => {
    const m = extractOrders(caps);
    expect(m.find((x) => x.key === "action_ship_within_24h")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "action_return_refund_requested")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "orders_to_ship")?.valueNum).toBe(6);
    expect(m.find((x) => x.key === "orders_shipped")?.valueNum).toBe(1);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractOrders([])).toEqual([]);
  });
});

describe("extractReturns (real fixture)", () => {
  it("bóc respond_24h / auto_approved_7d / can_be_appealed / disputes", () => {
    const caps: Capture[] = [
      {
        url: "https://seller-us.tiktok.com/api/v1/reverse/dashboard/get",
        status: 200,
        body: {
          data: {
            dashboard_columns: [
              { title_text: "Respond within 24 hours", order_count: 0 },
              { title_text: "Auto-approved (last 7d)", order_count: 2 },
              { title_text: "Can be appealed", order_count: 1 },
              { title_text: "Disputes awaiting response", order_count: 0 },
            ],
          },
        },
      },
    ];
    const m = extractReturns(caps);
    expect(m.find((x) => x.key === "return_respond_within_24h")?.valueNum).toBe(0);
    expect(m.find((x) => x.key === "return_auto_approved_7d")?.valueNum).toBe(2);
    expect(m.find((x) => x.key === "return_can_be_appealed")?.valueNum).toBe(1);
    expect(m.find((x) => x.key === "return_disputes_awaiting_response")?.valueNum).toBe(0);
  });
  it("không vỡ khi captures rỗng", () => {
    expect(extractReturns([])).toEqual([]);
  });
});

// Compass sales endpoint cũ (extractCompassOverview) giữ làm unit test contract synthetic.
describe("extractCompassOverview (synthetic — legacy, giữ cho phase sau)", () => {
  it("bóc gmv/orders/conversion khi có data", () => {
    const caps: Capture[] = [
      {
        url: "https://seller-us.tiktok.com/bff/compass/overview",
        status: 200,
        body: { data: { overview: { gmv: { amount: "1234.5" }, order_cnt: 42, conversion_rate: "2.3%" } } },
      },
    ];
    const m = extractCompassOverview(caps);
    expect(m.find((x) => x.key === "gmv")?.valueNum).toBe(1234.5);
    expect(m.find((x) => x.key === "orders")?.valueNum).toBe(42);
    expect(m.find((x) => x.key === "conversion_rate")?.valueNum).toBe(2.3);
  });
});
