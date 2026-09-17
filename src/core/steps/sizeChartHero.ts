import sharp from "sharp";

/**
 * Ảnh sản phẩm làm dải hero cho size chart.
 *
 * Ảnh studio nền TRẮNG (đa số ảnh SHEIN) làm hero vô nghĩa: phải phủ thật đậm chữ mới đọc
 * được, kết quả chỉ còn một mảng xám. Nên ở đây ưu tiên ảnh TỐI/có bối cảnh, và nếu mọi ảnh
 * đều quá sáng thì trả null để caller dùng header đặc như cũ.
 */
const MAX_BRIGHTNESS = 185; // 0..255 — trên ngưỡng này coi như ảnh studio nền trắng

const fetchBuf = async (url: string): Promise<Buffer | null> => {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null; // ảnh lỗi mạng → bỏ qua, hero là phần trang trí không đáng làm hỏng listing
  }
};

/** Gom ảnh ứng viên từ JSON crawl: ảnh sản phẩm + ảnh đầu của mỗi màu. */
export const heroCandidates = (data: any): string[] => {
  const out: string[] = [...(data?.product_images ?? [])];
  for (const item of data?.variant_images ?? []) {
    for (const v of Object.values(item ?? {})) {
      const arr = Array.isArray(v) ? v : [v];
      if (arr[0]) out.push(String(arr[0]));
    }
  }
  return out.filter((u) => typeof u === "string" && /^https?:/.test(u));
};

/**
 * Chọn 1 ảnh làm hero → trả data URI JPEG (nhúng thẳng vào HTML để render không phụ thuộc
 * mạng), hoặc null nếu không ảnh nào hợp.
 */
export const buildSizeChartHero = async (
  images: string[],
  opts?: { width?: number; height?: number; tries?: number }
): Promise<string | null> => {
  const width = opts?.width ?? 1200;
  const height = opts?.height ?? 215;
  const urls = [...new Set(images)].slice(0, opts?.tries ?? 4);
  if (!urls.length) return null;

  let best: { buf: Buffer; bright: number } | null = null;
  for (const u of urls) {
    const raw = await fetchBuf(u);
    if (!raw) continue;
    try {
      const crop = await sharp(raw).resize(width, height, { fit: "cover", position: "top" }).jpeg({ quality: 82 }).toBuffer();
      const st = await sharp(crop).stats();
      const bright = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
      if (!best || bright < best.bright) best = { buf: crop, bright };
    } catch {
      /* ảnh hỏng/định dạng lạ → thử ảnh kế */
    }
  }
  if (!best) return null;
  if (best.bright > MAX_BRIGHTNESS) {
    console.log(`🖼️ Size chart hero: ảnh sáng ${best.bright.toFixed(0)}/255 (studio nền trắng) → dùng header đặc.`);
    return null;
  }
  console.log(`🖼️ Size chart hero: dùng ảnh (độ sáng ${best.bright.toFixed(0)}/255).`);
  return `data:image/jpeg;base64,${best.buf.toString("base64")}`;
};
