/**
 * Viết hoa chữ cái đầu mỗi từ, GIỮ NGUYÊN phần còn lại của từ.
 * Cố ý không lowercase phần đuôi để không phá acronym/brand sẵn có
 * (vd "2-Piece", "USB", "ROMWE" giữ nguyên; "red summer" → "Red Summer").
 */
const toTitleCase = (s: string): string =>
  s.replace(/(^|\s)(\p{L})/gu, (_m, boundary, ch) => boundary + ch.toUpperCase());

/* ====================== SPORTS TITLE SANITIZER ====================== */

/**
 * Deterministic regex fallback: biến title đồ thể thao thành áo thường.
 * Chạy LUÔN cho mọi title (kể cả cache hit) để đảm bảo 100% không lọt.
 */

// Bước 1: Xoá hoàn toàn (trademark, CLB, cầu thủ, giải đấu)
const SPORTS_REMOVE: RegExp[] = [
  // Trademark tổ chức
  /\bFIFA\b/gi,
  /\bUEFA\b/gi,

  // Giải đấu (xoá hoàn toàn, không thay)
  /\bPremier\s*League\b/gi,
  /\bLa\s*Liga\b/gi,
  /\bBundesliga\b/gi,
  /\bSerie\s*A\b/gi,
  /\bLigue\s*1\b/gi,
  /\bMLS\b/gi,
  /\bAFC\b/gi,

  // CLB
  /\b(?:Barcelona|Barca|Real\s*Madrid|Manchester(?:\s*(?:United|City))?|Liverpool|Arsenal|Chelsea|Tottenham|Bayern(?:\s*Munich)?|PSG|Paris\s*Saint[\s-]*Germain|Juventus|Juve|AC\s*Milan|Inter\s*Milan|Borussia\s*Dortmund|Atletico(?:\s*Madrid)?|Napoli|Ajax|Benfica|Porto)\b/gi,

  // Cầu thủ
  /\b(?:Messi|Ronaldo|Neymar|Mbapp[eé]|Haaland|Salah|De\s*Bruyne|Modric|Kroos|Benzema|Lewandowski|Vinicius|Bellingham|Pedri|Gavi|Saka|Palmer|Foden)\b/gi,
];

// Bước 2: Thay thế (từ cụ thể trước, từ chung sau)
const SPORTS_REPLACE: [RegExp, string][] = [
  // Giải đấu → generic
  [/\bWorld\s*Cup\b/gi, "Tournament"],
  [/\bChampions\s*League\b/gi, "Championship"],
  [/\bEuro(?:\s*(?:20\d{2}|Cup))\b/gi, "Tournament"],
  [/\bCopa\s*America\b/gi, "Tournament"],

  // Cụm "Football/Soccer + loại đồ" → casual equivalent
  [/\b(?:Soccer|Football)\s*Jersey\b/gi, "Mesh Top"],
  [/\b(?:Soccer|Football)\s*Shirt\b/gi, "Camisole"],
  [/\b(?:Soccer|Football)\s*Kit\b/gi, "Outfit Set"],
  [/\b(?:Soccer|Football)\s*Uniform\b/gi, "Matching Set"],
  [/\b(?:Soccer|Football)\s*Dress\b/gi, "Mesh Dress"],
  [/\b(?:Soccer|Football)\s*Shorts?\b/gi, "Active Shorts"],
  [/\b(?:Soccer|Football)\s*Pants?\b/gi, "Active Pants"],
  [/\b(?:Soccer|Football)\s*Training\b/gi, "Active"],
  [/\b(?:Soccer|Football)\s*Top\b/gi, "Mesh Top"],

  // "Jersey" đơn lẻ (không kèm từ khác đã match ở trên)
  [/\bJersey\b/gi, "Top"],

  // Số áo #10 → Number 10
  [/#(\d{1,2})\b/g, "Number $1"],

  // Từ "Football" / "Soccer" đơn lẻ còn sót (sau khi đã xử lý cụm trên)
  [/\bFootball\b/gi, "Sport"],
  [/\bSoccer\b/gi, "Sport"],
];

const sanitizeSportsTitle = (title: string): string => {
  // Quick check: nếu không chứa keyword thể thao → skip hoàn toàn
  if (!/jersey|football|soccer|world\s*cup|fifa|uefa|champions\s*league|premier\s*league|la\s*liga|bundesliga|serie\s*a|ligue\s*1|euro\s*(cup|20)|copa\s*america|barcelona|barca|real\s*madrid|manchester|liverpool|arsenal|chelsea|tottenham|bayern|psg|juventus|juve|ac\s*milan|inter\s*milan|messi|ronaldo|neymar|mbapp|haaland|salah/i.test(title)) {
    return title;
  }

  let result = title;

  // Bước 1: Xoá
  for (const re of SPORTS_REMOVE) {
    result = result.replace(re, "");
  }

  // Bước 2: Thay thế
  for (const [re, replacement] of SPORTS_REPLACE) {
    result = result.replace(re, replacement);
  }

  // Bước 3: Cleanup
  result = result
    .replace(/\s{2,}/g, " ")       // khoảng trắng thừa
    .replace(/(?:^[\s,\-]+)|(?:[\s,\-]+$)/g, "")  // đầu/cuối
    .replace(/\s*,\s*,+/g, ",")    // dấu phẩy thừa
    .replace(/\s+-\s*-+\s+/g, " ") // dấu gạch thừa
    .trim();

  console.log(`⚽→👕 Sports title sanitized: "${title}" → "${result}"`);
  return result;
};

/* ====================== CLEAN TITLE ====================== */

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
  const sanitized = sanitizeSportsTitle(titled);
  return (prefix + sanitized).trim();
};
