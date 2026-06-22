/** Lọc category THỜI TRANG (quần áo/giày/túi) khỏi jewelry/phone/beauty/home… */
const FASHION_RE = /\b(women'?s|men'?s|kid'?s|girl'?s|boy'?s)\b|dress|skirt|\btops?\b|blouse|shirt|t-?shirt|\btee\b|cami|tank|bottom|pant|trouser|legging|jean|denim|\bshorts?\b|swim|bikini|beachwear|lingerie|underwear|shapewear|\bbra\b|sleepwear|loungewear|outfit|jumpsuit|romper|bodysuit|co-?ord|two.?piece|jacket|coat|blazer|sweater|hoodie|cardigan|knitwear|\bshoes?\b|sneaker|boot|sandal|\bheel|cloth(es|ing)?|apparel|activewear|sportswear|sport.*(clothing|wear)|fashion accessor|\bbags?\b|handbag/i;
const NONFASHION_RE = /jewel|\bring\b|necklace|bracelet|earring|fragrance|perfume|phone|electronic|camera|appliance|kitchen|food|beverage|supplement|nutrition|\bbeauty\b|skincare|makeup|cosmetic|hair ?care|\bhome\b|furniture|\bpet\b|\btoy|baby|car\b|motor|\btool|book|trading card|\bwig\b|\bnail|health|wellness|washes|wipes|intimate wash/i;

export function isFashionCategory(name: string): boolean {
  const n = (name || "").toLowerCase();
  if (NONFASHION_RE.test(n)) return false;
  return FASHION_RE.test(n);
}
