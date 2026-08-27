/**
 * Suy ngách cho 1 sản phẩm từ text (category breadcrumb + tên sp) bằng keyword.
 * Config: config/niche-keywords.json (rules theo thứ tự — ngách đầu match trước).
 * Trả null nếu không khớp ngách nào.
 */
import fs from "fs";
import path from "path";

interface NicheRule { niche: string; keywords: string[] }
let _rules: NicheRule[] | null = null;

function rules(): NicheRule[] {
  if (_rules) return _rules;
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "config", "niche-keywords.json"), "utf-8");
    const parsed = JSON.parse(raw);
    _rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    _rules = [];
  }
  return _rules!;
}

export function reloadNicheKeywords(): void { _rules = null; }

/** text = category + tên sp gộp lại. Trả niche_key đầu tiên có keyword xuất hiện, hoặc null. */
export function deriveNiche(text: string | null | undefined): string | null {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  for (const r of rules()) {
    if ((r.keywords || []).some((k) => k && t.includes(k.toLowerCase()))) return r.niche;
  }
  return null;
}
