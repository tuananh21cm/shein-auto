/** Kiểu sản phẩm SHEIN đã chuẩn hoá từ 2 nguồn RapidAPI khác nhau. */
export interface SheinProduct {
  goodsId: string;
  goodsSn: string;
  spu?: string;
  name: string;
  image: string; // URL https đầy đủ
  url?: string;
  catId?: string;
  catName?: string;
  storeCode?: string;
  brandCode?: string;
  /** Giá bán hiện tại (USD) */
  price: number | null;
  /** Giá gốc (USD) */
  retailPrice: number | null;
  /** % giảm giá (0-100) */
  discountPct: number | null;
  /** Số review — proxy cho lượng bán */
  commentNum: number;
  /** Điểm rating trung bình (0-5) */
  rating: number | null;
  labels: string[];
  /** % người mua báo "true to size" (0-100). Chỉ có từ nguồn category (SSR gbRawData). */
  trueToSize?: number | null;
  /** SHEIN gắn cờ "bán chạy nhất" trong list. Chỉ nguồn category. */
  isHighestSales?: boolean;
  /** SHEIN gắn cờ "giá thấp nhất". Chỉ nguồn category. */
  isLowestPrice?: boolean;
  /** Hết hàng. Chỉ nguồn category. */
  soldOutStatus?: boolean;
  source: "shein-data-api" | "shein-online-data" | "shein-category";
}

/** Chi tiết đầy đủ 1 sản phẩm. */
export interface SheinProductDetail {
  goodsId: string;
  goodsSn: string;
  name: string;
  catName?: string;
  storeCode?: string;
  price: number | null;
  retailPrice: number | null;
  mainImage: string;
  images: string[];
  attributes: { name: string; value: string }[];
  material: { name: string; value: string }[];
  relatedColors: { goodsId: string; image: string }[];
  description?: string;
  source: "shein-data-api" | "shein-online-data";
  raw?: any;
}

export interface SheinSearchResult {
  products: SheinProduct[];
  total: number;
  page: number;
  hasNext: boolean;
}
