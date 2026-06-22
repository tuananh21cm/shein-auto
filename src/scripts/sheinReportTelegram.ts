/**
 * SHEIN report ẢNH (chữ NHÚNG lên ảnh) → gửi THẲNG qua Telegram (Haiku-proof).
 * Search SHEIN → chấm winScore → overlay stats (win/★/review/giá) LÊN ảnh bằng sharp →
 * gửi ảnh đã annotate + caption (URL bấm được) tới chat Telegram của Hermes.
 * Agent chỉ CHẠY lệnh này, KHÔNG tự gửi/format ảnh → không thể từ chối.
 *
 * Usage: npx tsx src/scripts/sheinReportTelegram.ts "<keyword>" [limit]
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Database from "better-sqlite3";
import { searchProducts } from "../services/shein/client";
import { rankByWin } from "../core/winScore";

/** Shape thống nhất cho cả nguồn LIVE (RapidAPI) lẫn DB. */
interface Prod {
  goodsId: string;
  name: string; image: string; url: string;
  winScore: number; winTier: string;
  rating: number | null; commentNum: number;
  price: number | null; discountPct: number | null;
}

/** Set goods_id đã bị soft-delete (excluded_products) — để lọc khỏi báo cáo. */
function excludedSet(): Set<string> {
  try {
    const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='excluded_products'").get();
    const ids = has ? (db.prepare("SELECT goods_id FROM excluded_products").all() as any[]).map((r) => r.goods_id) : [];
    db.close();
    return new Set(ids);
  } catch { return new Set(); }
}

/** Fallback: đọc research_product trong DB khi RapidAPI lỗi/hết quota. */
function fromDb(kw: string, limit: number): Prod[] {
  try {
    const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
    const rows = db.prepare(
      `SELECT goods_id, name, image, url, win_score, win_tier, rating, comment_num, price, discount_pct
       FROM research_product WHERE (name LIKE '%'||?||'%' OR niche_key=?) AND image IS NOT NULL AND image!=''
         AND goods_id NOT IN (SELECT goods_id FROM excluded_products)
       GROUP BY goods_id ORDER BY opportunity_score DESC, win_score DESC LIMIT ?`
    ).all(kw, kw, limit) as any[];
    db.close();
    return rows.map((r) => ({
      goodsId: r.goods_id, name: r.name, image: r.image, url: r.url,
      winScore: r.win_score, winTier: r.win_tier || "good",
      rating: r.rating, commentNum: r.comment_num ?? 0,
      price: r.price, discountPct: r.discount_pct,
    }));
  } catch { return []; }
}

const HERMES_ENV = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"), "hermes", ".env");
function hEnv(key: string): string {
  try {
    const m = fs.readFileSync(HERMES_ENV, "utf8").match(new RegExp("^" + key + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^"|"$/g, "") : "";
  } catch { return ""; }
}

const TOKEN = hEnv("TELEGRAM_BOT_TOKEN");
const CHAT = (hEnv("TELEGRAM_ALLOWED_USERS") || "").split(",")[0].trim();
const out = (o: any) => console.log(JSON.stringify(o, null, 1));
const clean = (s: string, n = 60) => (s || "").replace(/[\[\]()<>&]/g, "").slice(0, n);
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Overlay { corner: string; left: string; right: string; line2: string; }
/** Overlay: badge góc trái-trên (rank) + box đáy [giá trái · điểm phải xanh] + dòng 2 (★rating·review). */
async function annotate(imgBuf: Buffer, o: Overlay): Promise<Buffer> {
  const img = sharp(imgBuf, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const W = meta.width ?? 405, H = meta.height ?? 552;
  const pad = Math.round(W * 0.045);
  const fsBig = Math.round(W * 0.09), fs2 = Math.round(W * 0.062);
  const boxH = Math.round(W * 0.26);
  const cFs = Math.round(W * 0.072);
  const cW = Math.round(cFs * (o.corner.length * 0.62 + 1.1));
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="6" rx="7" width="${cW}" height="${Math.round(cFs * 1.7)}" fill="black" fill-opacity="0.6"/>
      <text x="${6 + cW / 2}" y="${6 + cFs * 1.2}" font-family="Arial" font-size="${cFs}" font-weight="bold" fill="white" text-anchor="middle">${o.corner}</text>
      <rect x="0" y="${H - boxH}" width="${W}" height="${boxH}" fill="black" fill-opacity="0.55"/>
      <text x="${pad}" y="${H - boxH + fsBig * 1.05}" font-family="Arial" font-size="${fsBig}" font-weight="bold" fill="white" text-anchor="start">${o.left}</text>
      <text x="${W - pad}" y="${H - boxH + fsBig * 1.05}" font-family="Arial" font-size="${fsBig}" font-weight="bold" fill="#5cff5c" text-anchor="end">${o.right}</text>
      <text x="${W / 2}" y="${H - boxH + fsBig * 1.05 + fs2 * 1.35}" font-family="Arial" font-size="${fs2}" fill="#ffe08a" text-anchor="middle">${esc(o.line2)}</text>
    </svg>`
  );
  return img.composite([{ input: svg, gravity: "northwest" }]).jpeg({ quality: 88 }).toBuffer();
}

/** Tải + annotate 1 ảnh → buffer (null nếu lỗi). */
async function fetchAnnotated(imgUrl: string, o: Overlay): Promise<Buffer | null> {
  try {
    const r0 = await fetch(imgUrl);
    if (!r0.ok) return null;
    return await annotate(Buffer.from(await r0.arrayBuffer()), o);
  } catch { return null; }
}

/** Gửi 1 ALBUM (2-10 ảnh) dạng lưới qua sendMediaGroup. */
async function sendAlbum(photos: { buf: Buffer; caption: string }[]): Promise<number> {
  if (!photos.length) return 0;
  if (photos.length === 1) {
    const fd = new FormData();
    fd.append("chat_id", CHAT);
    fd.append("caption", photos[0].caption);
    fd.append("parse_mode", "HTML");
    fd.append("photo", new Blob([new Uint8Array(photos[0].buf)], { type: "image/jpeg" }), "p.jpg");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd as any });
    return (await r.json().catch(() => null))?.ok ? 1 : 0;
  }
  let sent = 0;
  // Telegram: tối đa 10 ảnh/album → chia chunk 10.
  for (let c = 0; c < photos.length; c += 10) {
    const chunk = photos.slice(c, c + 10);
    const fd = new FormData();
    fd.append("chat_id", CHAT);
    const media = chunk.map((p, i) => ({ type: "photo", media: `attach://photo${i}`, caption: p.caption, parse_mode: "HTML" }));
    fd.append("media", JSON.stringify(media));
    chunk.forEach((p, i) => fd.append(`photo${i}`, new Blob([new Uint8Array(p.buf)], { type: "image/jpeg" }), `photo${i}.jpg`));
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, { method: "POST", body: fd as any });
    const j: any = await r.json().catch(() => null);
    if (j && j.ok) sent += chunk.length;
  }
  return sent;
}

const main = async () => {
  const argv = process.argv.slice(2);
  const limit = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 6;
  const kw = argv.join(" ").trim();
  if (!kw) return out({ ok: false, error: 'Thiếu keyword. Dùng: npx tsx src/scripts/sheinReportTelegram.ts "lace bodysuit" 6' });
  if (!TOKEN || !CHAT) return out({ ok: false, error: "Thiếu TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS trong ~/.hermes/.env" });

  const excluded = excludedSet();
  let ranked: Prod[] = [];
  let source = "live";
  try {
    const res = await searchProducts(kw, { perPage: 40 });
    ranked = rankByWin(res.products).filter((p) => p.image && !excluded.has(p.goodsId)).slice(0, limit).map((p) => ({
      goodsId: p.goodsId, name: p.name, image: p.image, url: p.url || "", winScore: p.winScore, winTier: p.winTier,
      rating: p.rating, commentNum: p.commentNum, price: p.price, discountPct: p.discountPct,
    }));
  } catch { /* fallback DB */ }
  if (!ranked.length) { ranked = fromDb(kw, limit); source = "db"; }   // fromDb đã lọc excluded trong SQL
  if (!ranked.length) return out({ ok: false, error: `Không có sp/ảnh cho "${kw}" (cả RapidAPI lẫn DB)` });

  const items: any[] = [];
  const photos: { buf: Buffer; caption: string }[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    // Bố cục: rank góc trái-trên · giá đáy-trái (trắng) · điểm đáy-phải (xanh) · dòng2 ★rating·review.
    const o = { corner: `#${i + 1}`, left: `$${p.price ?? "-"}`, right: `${p.winScore}`, line2: `★${p.rating ?? "-"}  ·  ${p.commentNum} review` };
    const url = (p.url || "").split("?")[0];
    const buf = await fetchAnnotated(p.image, o);
    if (buf) photos.push({ buf, caption: `<b>#${i + 1} · ${esc(clean(p.name))}</b>\n🔗 ${url}` });
    items.push({ rank: i + 1, goodsId: p.goodsId, name: clean(p.name, 45), win: p.winScore, price: p.price, url, ok: !!buf });
  }

  const sent = await sendAlbum(photos);   // gửi dạng ALBUM (lưới 3 ô/dòng trên Telegram)
  out({ ok: true, keyword: kw, source, sentToTelegram: sent, total: ranked.length, items, hint: "Sếp bảo 'bỏ số N' → map rank N → goodsId trong items → chạy excludeProduct.ts <goodsId>." });
};

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }));
