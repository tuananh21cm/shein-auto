/** Lọc category THỜI TRANG (quần áo/giày/túi) khỏi jewelry/phone/beauty/home… */
const FASHION_RE = /\b(women'?s|men'?s|kid'?s|girl'?s|boy'?s)\b|dress|skirt|\btops?\b|blouse|shirt|t-?shirt|\btee\b|cami|tank|bottom|pant|trouser|legging|jean|denim|\bshorts?\b|swim|bikini|beachwear|lingerie|underwear|shapewear|\bbra\b|sleepwear|loungewear|outfit|jumpsuit|romper|bodysuit|co-?ord|two.?piece|jacket|coat|blazer|sweater|hoodie|cardigan|knitwear|\bshoes?\b|sneaker|boot|sandal|\bheel|cloth(es|ing)?|apparel|activewear|sportswear|sport.*(clothing|wear)|fashion accessor|\bbags?\b|handbag/i;
const NONFASHION_RE = /jewel|\bring\b|necklace|bracelet|earring|fragrance|perfume|phone|electronic|camera|appliance|kitchen|food|beverage|supplement|nutrition|\bbeauty\b|skincare|makeup|cosmetic|hair ?care|\bhome\b|furniture|\bpet\b|\btoy|baby|car\b|motor|\btool|book|trading card|\bwig\b|\bnail|health|wellness|washes|wipes|intimate wash/i;

export function isFashionCategory(name: string): boolean {
  const n = (name || "").toLowerCase();
  if (NONFASHION_RE.test(n)) return false;
  return FASHION_RE.test(n);
}

// Đồ TRẺ EM (khó list, chỉ giữ thời trang người lớn). Bắt theo tên SP + breadcrumb category.
// HARD_KIDS: tín hiệu kids CHẮC CHẮN. LƯU Ý: KHÔNG bắt "baby" đơn lẻ vì "baby tee/baby blue/
// baby pink" là đồ NGƯỜI LỚN → chỉ bắt "baby girl/boy" + toddler/kids/children/tween…
const HARD_KIDS = /\b(toddlers?|infants?|newborn|nursery|babies|children'?s?|kids?|youth|junior|preschool|tween)\b|\bbaby\s+(girl|boy)\b|\blittle\s+(girl|boy)\b|\b\d+\s?-\s?\d+\s?(months?|years?)\b|\b\d{1,2}t\b/i;
// girls/boys (số NHIỀU hoặc sở hữu) = kids; KHÔNG bắt "boy" đơn (boy shorts/boyfriend là đồ người lớn).
const GIRLBOY = /\b(girls|boys)\b|\b(girl|boy)'s\b/i;

/** true nếu là hàng trẻ em → LOẠI khỏi harvest/allocate/listing. Dùng cả tên + breadcrumb category. */
export function isKidsProduct(name?: string | null, catName?: string | null): boolean {
  const t = `${name || ""} ${catName || ""}`.toLowerCase();
  return HARD_KIDS.test(t) || GIRLBOY.test(t);
}
