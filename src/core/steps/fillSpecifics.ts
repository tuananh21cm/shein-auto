import { specificsMap, SpecificsMapFile } from "../../config/appConfig";

const norm = (s: string): string => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Gom SHEIN attributes thành { [4Seller field label]: [candidate values] }.
 * Nhiều SHEIN key có thể trỏ cùng 1 field (vd Material + Composition → "Material").
 * Bỏ key không có trong keyMap, và value rỗng.
 */
export function mapAttributesToFields(
  attributes: Record<string, string>,
  keyMap: Record<string, string | string[]>
): Record<string, string[]> {
  // Key dài trước → fuzzy ưu tiên match cụ thể hơn ("sleeve length" trước "length").
  const entries = Object.entries(keyMap).sort((a, b) => b[0].length - a[0].length);
  const out: Record<string, string[]> = {};
  for (const [rawKey, rawVal] of Object.entries(attributes || {})) {
    if (!rawVal || !rawVal.trim()) continue;
    const k = norm(rawKey);
    // 1. exact, 2. fuzzy: keyMap key xuất hiện trong SHEIN key (vd "Bikini Bottoms Sleeve Length")
    const field = keyMap[k] ?? entries.find(([mk]) => k.includes(mk))?.[1];
    if (!field) continue;
    // 1 key có thể trỏ nhiều field → đẩy value vào candidate của TẤT CẢ field đó
    const targets = Array.isArray(field) ? field : [field];
    for (const f of targets) (out[f] ??= []).push(rawVal.trim());
  }
  return out;
}

/**
 * Chọn option khớp nhất từ danh sách `options` (đọc từ dropdown DOM) cho 1 value SHEIN.
 * Bảo thủ: chỉ trả option khi đủ chắc (exact / chứa nhau / chung token ≥4 ký tự).
 * Không chắc → null (caller sẽ BỎ QUA field, không điền bừa).
 */
export function matchOption(
  rawValue: string,
  options: string[],
  synonyms: Record<string, string>
): string | null {
  if (!rawValue || !options?.length) return null;
  let v = norm(rawValue);
  if (synonyms[v]) v = norm(synonyms[v]); // áp synonym (vd "machine wash, do not dry clean" → "machine wash")
  const opts = options.map((o) => ({ raw: o, n: norm(o) })).filter((o) => o.n);

  // 1. Khớp tuyệt đối
  const exact = opts.find((o) => o.n === v);
  if (exact) return exact.raw;

  // 2. Chứa nhau (option nằm trong value hoặc ngược lại) — ưu tiên option dài nhất
  const contains = opts
    .filter((o) => v.includes(o.n) || o.n.includes(v))
    .sort((a, b) => b.n.length - a.n.length)[0];
  if (contains) return contains.raw;

  // 3. Chung token "có nghĩa" (≥4 ký tự) để tránh khớp nhầm theo and/with/the
  const vt = new Set(v.split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  if (vt.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const o of opts) {
    const ot = o.n.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const shared = ot.filter((w) => vt.has(w)).length;
    if (shared > bestScore) {
      bestScore = shared;
      best = o.raw;
    }
  }
  return bestScore >= 1 ? best : null;
}

/**
 * Quyết định nên điền gì cho từng field (thuần, test được): trả { field: chosenOption }.
 * `fieldOptions` = options đọc từ DOM cho từng field. Field không khớp → không có trong kết quả.
 */
export function resolveSpecifics(
  attributes: Record<string, string>,
  fieldOptions: Record<string, string[]>,
  cfg: SpecificsMapFile
): Record<string, string> {
  const candidates = mapAttributesToFields(attributes, cfg.keyMap);
  const result: Record<string, string> = {};
  for (const [field, values] of Object.entries(candidates)) {
    const options = fieldOptions[field];
    if (!options?.length) continue;
    for (const v of values) {
      const hit = matchOption(v, options, cfg.valueSynonyms);
      if (hit) {
        result[field] = hit;
        break;
      }
    }
  }
  return result;
}

/**
 * Điền mục Specifics (Optional) trên 4Seller từ SHEIN attributes.
 * Pha: với mỗi field map được → mở dropdown (input placeholder "Select <field>"),
 * đọc option thật từ DOM, khớp chuỗi, click option khớp. Không khớp → Escape, bỏ qua.
 */
/**
 * DEBUG: liệt kê mọi dropdown "Select ..." trên trang + options thật, để map chính xác
 * theo từng category. Bật bằng env DEBUG_SPECIFICS=1.
 */
async function dumpSpecificsSchema(page: any, wantedFields: string[]): Promise<void> {
  try {
    console.log(`🔎 [DBG] Muốn điền: ${JSON.stringify(wantedFields)}`);
    for (let y = 0; y < 8; y++) {
      await page.mouse.wheel(0, 800).catch(() => {});
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);

    // Field Specifics: input placeholder "Select <field>" trong #tiktokSpecifics → options thật
    const selects = page.locator('#tiktokSpecifics input[placeholder^="Select "]');
    const n = await selects.count();
    console.log(`🔎 [DBG] ${n} field "Select ..." trong #tiktokSpecifics:`);
    for (let i = 0; i < n; i++) {
      const el = selects.nth(i);
      let ph = "";
      let opts: string[] = [];
      try {
        ph = (await el.getAttribute("placeholder")) || "";
        const wrapper = el.locator('xpath=ancestor::div[contains(@class,"el-select")][1]');
        const opener = (await wrapper.count()) > 0 ? wrapper.first() : el;
        await opener.scrollIntoViewIfNeeded();
        await opener.click();
        await page.waitForTimeout(280);
        opts = (await page.locator(".el-select-dropdown:visible .el-select-dropdown__item").allInnerTexts())
          .map((s: string) => s.trim())
          .filter(Boolean);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
      } catch {}
      console.log(`   • "${ph}" (${opts.length}): ${opts.slice(0, 45).join(" | ")}`);
    }
  } catch (e: any) {
    console.warn("🔎 [Specifics DEBUG] dump lỗi:", e?.message);
  }
}

/** Mở rộng Specifics: click "Show more" để render các field Optional (Pattern, Occasion...). */
async function expandSpecifics(page: any): Promise<void> {
  try {
    const sec = page.locator("#tiktokSpecifics");
    const showMore = sec.getByText(/show more/i).first();
    if ((await showMore.count()) > 0) {
      await showMore.scrollIntoViewIfNeeded();
      await showMore.click();
      await page.waitForTimeout(800);
      console.log('📂 Specifics: đã click "Show more" để mở các field Optional');
    }
  } catch (e: any) {
    console.warn("⚠️ Specifics: click Show more lỗi:", e?.message);
  }
}

export const fillSpecifics = async (page: any, attributes: Record<string, string>): Promise<void> => {
  console.log("--- Đang điền Specifics (map SHEIN → 4Seller) ---");
  const cfg = specificsMap();
  const candidates = mapAttributesToFields(attributes, cfg.keyMap);
  const fields = Object.keys(candidates);

  await expandSpecifics(page); // mở Optional trước khi tìm field

  if (process.env.DEBUG_SPECIFICS) await dumpSpecificsSchema(page, fields);

  if (fields.length === 0) {
    console.log("⏭️ Không có attribute nào map được sang Specifics, bỏ qua.");
    return;
  }

  let filled = 0;
  for (const field of fields) {
    try {
      const input = page.getByPlaceholder(`Select ${field}`).first();
      if ((await input.count()) === 0) {
        // Field không có trong category hiện tại → bỏ qua
        continue;
      }
      // Mở dropdown qua wrapper .el-select — input readonly bị .el-select__tags chặn ở multi-select.
      const wrapper = input.locator('xpath=ancestor::div[contains(@class,"el-select")][1]');
      const opener = (await wrapper.count()) > 0 ? wrapper.first() : input;
      await opener.scrollIntoViewIfNeeded();
      await opener.click();
      await page.waitForTimeout(400);

      const optionLoc = page.locator(".el-select-dropdown:visible .el-select-dropdown__item");
      const options = (await optionLoc.allInnerTexts()).map((s: string) => s.trim()).filter(Boolean);

      let chosen: string | null = null;
      for (const v of candidates[field]) {
        chosen = matchOption(v, options, cfg.valueSynonyms);
        if (chosen) break;
      }

      if (chosen) {
        const opt = page
          .locator(".el-select-dropdown:visible .el-select-dropdown__item")
          .filter({ hasText: new RegExp(`^\\s*${escapeRegex(chosen)}\\s*$`, "i") })
          .first();
        if ((await opt.count()) > 0) {
          await opt.click();
          filled++;
          console.log(`✅ Specifics: ${field} = "${chosen}"`);
        }
      } else {
        console.log(`⏭️ Specifics: ${field} — value SHEIN không khớp option, bỏ qua.`);
      }
      // Đóng dropdown (multi-select không tự đóng sau khi chọn)
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    } catch (e: any) {
      console.warn(`⚠️ Specifics: lỗi ở field "${field}", bỏ qua:`, e?.message);
      try {
        await page.keyboard.press("Escape");
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`✅ Hoàn thành Specifics: điền ${filled}/${fields.length} field map được.`);
};
