/**
 * Điền 2 field TikTok mới trong form Edit Draft 4Seller:
 *   - "Search terms"       (input, max 250 ký tự, phẩy-cách) — backend keywords cho search
 *   - "Product highlights" (textarea, max 1500 ký tự, mỗi dòng 1 ý)
 * Data do generateRichDescription sinh kèm (searchTerms + productHighlights).
 * Không critical: không tìm thấy ô / lỗi → log cảnh báo, KHÔNG fail listing.
 */

const SEARCH_TERMS_MAX = 250;
const HIGHLIGHTS_MAX = 1500;

/** Ghép terms phẩy-cách, bỏ term làm tràn 250 ký tự (giữ nguyên thứ tự ưu tiên AI trả về). */
export const joinSearchTerms = (terms: string[]): string => {
  let out = "";
  for (const t of terms.map((x) => (x || "").trim()).filter(Boolean)) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > SEARCH_TERMS_MAX) break;
    out = next;
  }
  return out;
};

/** Ghép highlights mỗi dòng 1 ý, cắt ở 1500 ký tự (bỏ dòng làm tràn). */
export const joinHighlights = (lines: string[]): string => {
  let out = "";
  for (const l of lines.map((x) => (x || "").trim()).filter(Boolean)) {
    const next = out ? `${out}\n${l}` : l;
    if (next.length > HIGHLIGHTS_MAX) break;
    out = next;
  }
  return out;
};

async function findAndFill(page: any, candidates: any[], value: string, label: string): Promise<void> {
  let input: any = null;
  for (const cand of candidates) {
    if ((await cand.count()) > 0) { input = cand.first(); break; }
  }
  if (!input) {
    console.warn(`⚠️ Không tìm thấy ô '${label}' — 4Seller có thể chưa có field này cho shop. Bỏ qua.`);
    return;
  }
  await input.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.waitForTimeout(300);

  await input.click();
  await input.fill(value);
  await page.waitForTimeout(300);
  let val = await input.inputValue().catch(() => "");
  if (!val || !val.includes(value.slice(0, 15))) {
    console.warn(`⚠️ fill() '${label}' không vào (got="${String(val).slice(0, 40)}"), thử pressSequentially...`);
    await input.click();
    await input.fill("").catch(() => {});
    await input.pressSequentially(value, { delay: 10 });
    await page.waitForTimeout(300);
    val = await input.inputValue().catch(() => "");
  }
  if (val && val.includes(value.slice(0, 15))) {
    console.log(`🔎 Đã điền ${label} (${val.length} ký tự).`);
  } else {
    console.warn(`⚠️ Vẫn không điền được '${label}'. Bỏ qua, không fail listing.`);
  }
}

export const fillSearchTermsAndHighlights = async (
  page: any,
  searchTerms?: string[] | null,
  productHighlights?: string[] | null
): Promise<void> => {
  try {
    // DOM thật 4Seller: <div class="extra_field"><div class="extra_label">Search terms</div>
    //   <div class="extra_input_wrap"> <input class="el-input__inner" maxlength="250"
    //   placeholder="Separate multiple search terms with commas"> ...
    const termsStr = joinSearchTerms(searchTerms || []);
    if (termsStr) {
      await findAndFill(
        page,
        [
          page.getByPlaceholder(/Separate multiple search terms/i),
          page.locator(".extra_field").filter({ hasText: "Search terms" }).locator("input.el-input__inner, input, textarea"),
          page.locator('input[maxlength="250"][placeholder*="search terms" i]'),
        ],
        termsStr,
        "Search terms"
      );
    }

    const hlStr = joinHighlights(productHighlights || []);
    if (hlStr) {
      await findAndFill(
        page,
        [
          page.getByPlaceholder(/Enter one highlight per line/i),
          page.locator(".extra_field").filter({ hasText: "Product highlights" }).locator("textarea, input.el-input__inner, input"),
          page.locator('textarea[maxlength="1500"], :is(textarea, input)[placeholder*="highlight" i]'),
        ],
        hlStr,
        "Product highlights"
      );
    }
  } catch (error: any) {
    console.warn(`⚠️ Lỗi điền Search terms/Highlights (bỏ qua, không fail listing): ${error?.message ?? error}`);
  }
};
