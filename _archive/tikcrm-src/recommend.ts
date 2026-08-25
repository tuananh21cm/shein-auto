/**
 * Phase 3 — AI đề xuất chiến lược (Gemini) cho từng shop.
 *
 * Đọc kho snapshot (index + listing per-SKU + order-status + promotion 4Seller) →
 * Gemini 2.5 Flash → JSON đề xuất: xóa listing nào, flash listing nào, làm video listing nào,
 * cảnh báo, định hướng. Lưu recommendations vào kho ngày + đếm vào index.
 * Chỉ chạy shop ĐỦ DATA (có listing).
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";
import { getListings } from "./listingsStore";
import { getRaw } from "./rawStore";
import { getDailySeries, getDaySnapshot, dayKey, recordDaily, listMetaShops } from "./dailyStore";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface ShopRecommendation {
  tom_tat: string;
  canh_bao: string[];
  xoa: { san_pham: string; ly_do: string }[];
  flash: { san_pham: string; ly_do: string }[];
  video: { san_pham: string; ly_do: string }[];
  dinh_huong: string[];
}

const SYSTEM = `
Bạn là chuyên gia vận hành TikTok Shop US mảng dropship (thời trang/đồ gia dụng), tư vấn cho seller quản lý nhiều shop.
Bạn nhận số liệu 1 shop (sức khỏe, tài chính, đơn, danh sách listing kèm view/đơn/GMV 28 ngày + đà tăng giảm, promotion) và đưa ra ĐỀ XUẤT HÀNH ĐỘNG cụ thể.

NGUYÊN TẮC:
- Trả lời hoàn toàn bằng TIẾNG VIỆT, ngắn gọn, hành động được ngay. KHÔNG bịa số shop không có.
- ⚠️ TUYỆT ĐỐI KHÔNG nhắc tồn kho / stock / "xả kho" — shop bán DROPSHIP, tồn là ẢO. Chỉ dùng view, đơn, GMV, đà tăng giảm làm căn cứ.
- "xoa": listing NÊN XÓA/ẩn — đã list lâu mà view thấp + không đơn. KHÔNG đề xuất xóa SP mới list (chưa đủ thời gian có view).
- "flash": listing NÊN ĐẨY FLASH SALE — view/traffic cao nhưng ít/không đơn (chuyển đổi kém) → hạ giá kích cầu. Nêu tên SP + lý do.
- "video": listing NÊN LÀM VIDEO — view cao / đà tăng mạnh / tiềm năng viral. Nêu tên SP + lý do.
- Mỗi list tối đa ~8 mục, ưu tiên tác động cao nhất. Nếu không có ứng viên rõ ràng thì để mảng rỗng.
- "canh_bao": rủi ro cần xử gấp (overdue giao hàng, logistics, vi phạm, sức khỏe shop, dòng tiền hold).
- "dinh_huong": 2-4 gạch đầu dòng định hướng shop (ngách, giá, khuyến mãi, nội dung).
- "tom_tat": 1-2 câu tổng thể.
`.trim();

const SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    tom_tat: { type: SchemaType.STRING },
    canh_bao: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    xoa: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { san_pham: { type: SchemaType.STRING }, ly_do: { type: SchemaType.STRING } }, required: ["san_pham", "ly_do"] } },
    flash: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { san_pham: { type: SchemaType.STRING }, ly_do: { type: SchemaType.STRING } }, required: ["san_pham", "ly_do"] } },
    video: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { san_pham: { type: SchemaType.STRING }, ly_do: { type: SchemaType.STRING } }, required: ["san_pham", "ly_do"] } },
    dinh_huong: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["tom_tat", "canh_bao", "xoa", "flash", "video", "dinh_huong"],
} as const;

const money = (o: any) => (o == null ? "?" : typeof o === "object" ? `${o.amount ?? "?"} ${o.currency ?? ""}` : String(o));

function buildPrompt(code: string): { prompt: string; listingCount: number } | null {
  const idx = (getDailySeries(code, 1)[0] ?? {}) as any;
  const listings = getListings(code).listings ?? [];
  if (!listings.length) return null; // chưa đủ data

  const os = getRaw("orderstatus", code);
  const osCols = os && Array.isArray(os.columns) ? os.columns.filter((c: any) => c.count > 0) : [];
  const fsSnap = getDaySnapshot(code, dayKey()).fourseller;

  // gửi tối đa 80 listing, sort view giảm dần (đủ để chọn video/flash/xóa)
  const rows = listings
    .slice()
    .sort((a: any, b: any) => (b.pv_28d || 0) - (a.pv_28d || 0))
    .slice(0, 80)
    .map((x: any) => `${String(x.product_name || x.product_id).slice(0, 60)} | pv ${x.pv_28d ?? 0} | Δpv ${x.d_pv ?? "?"} | đơn ${x.orders_28d ?? 0} | gmv ${x.gmv_28d ?? "?"}`)
    .join("\n");

  const prompt = `
SHOP: ${idx.shop_name ?? code} (${idx.region ?? "US"}) · trạng thái: ${idx.shop_status ?? "?"} · AHR level: ${idx.assessment_level ?? "?"} · điểm shop: ${idx.violation_score ?? "?"}/200 (max 200 là tốt; mỗi vi phạm bị TRỪ điểm; càng thấp càng nguy)
TÀI CHÍNH: net earnings ${money(idx.net_earnings)} · on hold ${money(idx.on_hold)} · holding ${money(idx.total_holding)}
ĐƠN: hôm nay ${idx.daily_orders ?? "?"} · tổng ${idx.total_order ?? "?"} · tổng listing ${idx.total_listings ?? listings.length}
CẦN XỬ LÝ (order): ${osCols.length ? osCols.map((c: any) => `${c.title}: ${c.count}`).join(" · ") : "không"}
PROMOTION 4Seller: ${fsSnap ? `Flash ${fsSnap.promo_flash ?? 0} · Discount ${fsSnap.promo_discount ?? 0}` : "chưa map 4Seller"}

DANH SÁCH LISTING (view/đơn/GMV 28 ngày, Δpv = đà view so lần cào trước):
${rows}

Hãy đề xuất theo JSON schema. Chọn SP CỤ THỂ theo tên ở trên cho xoa/flash/video.
`.trim();
  return { prompt, listingCount: listings.length };
}

/** Chạy AI đề xuất cho 1 shop. Trả về recommendation (hoặc null nếu thiếu data/lỗi). */
export async function recommendShop(code: string): Promise<ShopRecommendation | null> {
  const built = buildPrompt(code);
  if (!built) return null;
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM,
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA as any },
    });
    const result = await retryGemini(() => model.generateContent(built.prompt));
    const rec = JSON.parse(result.response.text()) as ShopRecommendation;
    recordDaily("recommendations", { payload: { shop_code: code, ...rec } });
    return rec;
  } catch (e: any) {
    console.error(`[recommend] ${code} lỗi: ${e?.message ?? e}`);
    return null;
  }
}

/** Chạy cho MỌI shop đủ data (có listing). onLog stream tiến độ. */
export async function recommendAll(onLog: (m: string) => void = () => {}): Promise<{ total: number; done: number; skipped: number }> {
  const shops = listMetaShops();
  let done = 0, skipped = 0;
  for (const s of shops) {
    const built = buildPrompt(s.shop_code);
    if (!built) { skipped++; continue; }
    const r = await recommendShop(s.shop_code);
    if (r) { done++; onLog(`✓ ${s.shop_code}: xóa ${r.xoa.length} · flash ${r.flash.length} · video ${r.video.length}`); }
    else onLog(`✗ ${s.shop_code}: lỗi/bỏ`);
  }
  onLog(`Xong: ${done} shop có đề xuất, bỏ ${skipped} shop thiếu data.`);
  return { total: shops.length, done, skipped };
}
