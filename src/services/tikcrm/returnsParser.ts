/**
 * Parse dữ liệu Returns & Refunds từ BFF TikTok reverse (server-driven UI).
 *   - dashboard/get → 4 tiles {title, count}
 *   - component/orders/list → từng đơn return (card server-driven → trích text)
 * Parse ở SERVER để chỉnh mà không phải re-patch extension.
 */
export interface ReturnTile { column_id: string; title: string; count: number; }
export interface ReturnOrder {
  order_id: string; return_id: string; type: string; reason: string;
  item_count: string; paid: string; refund: string; status: string; actions: string[];
}

const TYPES = ["Return and refund", "Refund only", "Replace", "Exchange item", "Exchange", "Appeal", "Dispute"];
const STATUS_RE = /(in progress|in transit|shipped|await|approv|permitted|requested|refunded|resolved|closed|processing|inspect|delivered|received|rejected|declined|cancel)/i;

export function parseReturnsDashboard(resp: any): ReturnTile[] {
  const cols = resp?.data?.dashboard_columns ?? resp?.dashboard_columns ?? [];
  return (Array.isArray(cols) ? cols : []).map((c: any) => ({
    column_id: String(c.column_id ?? ""),
    title: String(c.title_text ?? c.title ?? ""),
    count: Number(c.order_count ?? c.count ?? 0) || 0,
  }));
}

/** Gom mọi chuỗi có nghĩa trong card (theo thứ tự): title/content/text + copy_content + button. */
function collectStrings(o: any, out: string[]): void {
  if (o == null) return;
  if (Array.isArray(o)) { for (const x of o) collectStrings(x, out); return; }
  if (typeof o === "object") {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if ((k === "content" || k === "title" || k === "text") && typeof v === "string" && v.trim()) out.push(v.trim());
      else if (k === "copy_content" && v) out.push("#ID#" + String(v));
      collectStrings(v, out);
    }
  }
}

const isNumId = (s: string) => /^\d{15,}$/.test(s);

export function parseReturnsOrders(resp: any): ReturnOrder[] {
  const cards = resp?.data?.cards ?? resp?.cards ?? [];
  const out: ReturnOrder[] = [];
  for (const cardWrap of Array.isArray(cards) ? cards : []) {
    const S: string[] = [];
    collectStrings(cardWrap, S);
    // tách id (#ID# đánh dấu copy_content) + text thường
    const ids: string[] = [];
    const T: string[] = [];
    for (const s of S) {
      if (s.startsWith("#ID#")) { const v = s.slice(4); if (isNumId(v)) ids.push(v); }
      else T.push(s);
    }
    const after = (label: RegExp): string => {
      const i = T.findIndex((x) => label.test(x));
      return i >= 0 && i + 1 < T.length ? T[i + 1] : "";
    };
    const order_id = (() => { const i = T.findIndex((x) => /^order id$/i.test(x)); const v = i >= 0 ? T[i + 1] : ""; return isNumId(v) ? v : (ids.find((d) => d.length <= 18) || ids[0] || ""); })();
    const return_id = (() => { const v = after(/return (order )?id/i); return isNumId(v) ? v : (ids.find((d) => d !== order_id) || ""); })();
    const type = TYPES.find((t) => T.some((x) => x.toLowerCase() === t.toLowerCase())) || after(/request type/i) || "";
    const reason = after(/^reason$/i);
    const item_count = T.find((x) => /^\d+\s+items?$/i.test(x)) || "";
    const paidRefund = T.filter((x) => /^\$[\d.,]+$/.test(x));
    const paid = (() => { const v = after(/^paid$/i); return /^\$/.test(v) ? v : (paidRefund[0] || ""); })();
    const refund = (() => { const v = after(/^refund$/i); return /^\$/.test(v) ? v : (paidRefund[1] || paidRefund[0] || ""); })();
    // status: chuỗi có nghĩa trạng thái (có khoảng trắng, không phải label/type/reason/nút)
    const buttons = new Set(["Start chat", "Inspect package", "Check return logistics", "Create ticket", "View", "Appeal", "Confirm"]);
    const status = T.find((x) => STATUS_RE.test(x) && x.includes(" ") && !buttons.has(x) && x.toLowerCase() !== reason.toLowerCase() && !TYPES.includes(x) && !/^reason$|^request type$/i.test(x)) || "";
    const actions = [...new Set(T.filter((x) => buttons.has(x)))];
    if (order_id || return_id) out.push({ order_id, return_id, type, reason, item_count, paid, refund, status, actions });
  }
  return out;
}

export interface ReturnsParsed { tiles: ReturnTile[]; orders: ReturnOrder[]; awaiting_action: number; }

export function parseReturns(dashboardResp: any, ordersResp: any): ReturnsParsed {
  const tiles = parseReturnsDashboard(dashboardResp);
  const orders = parseReturnsOrders(ordersResp);
  const respond = tiles.find((t) => /respond within 24|awaiting your action/i.test(t.title));
  return { tiles, orders, awaiting_action: respond ? respond.count : orders.length };
}
