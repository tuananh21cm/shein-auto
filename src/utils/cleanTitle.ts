/**
 * Viết hoa chữ cái đầu mỗi từ, GIỮ NGUYÊN phần còn lại của từ.
 * Cố ý không lowercase phần đuôi để không phá acronym/brand sẵn có
 * (vd "2-Piece", "USB", "ROMWE" giữ nguyên; "red summer" → "Red Summer").
 */
const toTitleCase = (s: string): string =>
  s.replace(/(^|\s)(\p{L})/gu, (_m, boundary, ch) => boundary + ch.toUpperCase());

export const cleanTitle = (input: any, brand: string = ""): string => {
  const prefix = brand && brand.trim() ? `${brand.trim()} ` : "";

  // Lấy phần text sản phẩm (KHÔNG gồm brand) từ các dạng input khác nhau
  let productText = "";
  if (typeof input === "object" && input !== null) {
    if (input.text && input.text.thirdPartyData) {
      productText = input.text.thirdPartyData;
    } else if (input.thirdPartyData) {
      productText = input.thirdPartyData;
    } else {
      productText = JSON.stringify(input);
    }
  } else if (typeof input === "string") {
    if (input.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(input);
        productText = parsed.thirdPartyData || (parsed.text && parsed.text.thirdPartyData) || input;
      } catch {
        productText = input;
      }
    } else {
      productText = input;
    }
  }

  // Viết hoa chữ cái đầu mỗi từ cho phần text sản phẩm; brand giữ nguyên case.
  const titled = toTitleCase(productText.trim());
  return (prefix + titled).trim();
};
