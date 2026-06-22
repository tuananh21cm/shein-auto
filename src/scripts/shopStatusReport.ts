/**
 * shopStatusReport — album Telegram trạng thái listing của 1 shop: ĐÃ LIST / CHƯA LIST.
 * Đọc shop_allocation (status: allocated=chưa cào, crawled=có JSON chưa list, listed=đã lên sàn).
 *
 * Usage: npx tsx src/scripts/shopStatusReport.ts "<shop>" [all|listed|pending] [N]
 *   pending = allocated + crawled (chưa lên sàn). mặc định all, N=9.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Database from "better-sqlite3";

const HERMES_ENV = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"), "hermes", ".env");
const hEnv = (k: string) => { try { const m = fs.readFileSync(HERMES_ENV, "utf8").match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^"|"$/g, "") : ""; } catch { return ""; } };
const TOKEN = hEnv("TELEGRAM_BOT_TOKEN");
const CHAT = (hEnv("TELEGRAM_ALLOWED_USERS") || "").split(",")[0].trim();
const out = (o: any) => console.log(JSON.stringify(o, null, 1));
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (s: string, n = 55) => (s || "").replace(/[\[\]()<>&]/g, "").slice(0, n);

interface Overlay { corner: string; left: string; right: string; line2: string; }
async function annotate(imgBuf: Buffer, o: Overlay): Promise<Buffer> {
  const img = sharp(imgBuf, { failOn: "none" }).rotate();
  const m = await img.metadata();
  const W = m.width ?? 405, H = m.height ?? 552;
  const pad = Math.round(W * 0.045), fsBig = Math.round(W * 0.09), fs2 = Math.round(W * 0.062), boxH = Math.round(W * 0.26);
  const cFs = Math.round(W * 0.072), cW = Math.round(cFs * (o.corner.length * 0.62 + 1.1));
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="6" y="6" rx="7" width="${cW}" height="${Math.round(cFs * 1.7)}" fill="black" fill-opacity="0.6"/>
    <text x="${6 + cW / 2}" y="${6 + cFs * 1.2}" font-family="Arial" font-size="${cFs}" font-weight="bold" fill="white" text-anchor="middle">${o.corner}</text>
    <rect x="0" y="${H - boxH}" width="${W}" height="${boxH}" fill="black" fill-opacity="0.55"/>
    <text x="${pad}" y="${H - boxH + fsBig * 1.05}" font-family="Arial" font-size="${fsBig}" font-weight="bold" fill="white" text-anchor="start">${o.left}</text>
    <text x="${W - pad}" y="${H - boxH + fsBig * 1.05}" font-family="Arial" font-size="${fsBig}" font-weight="bold" fill="#5cff5c" text-anchor="end">${o.right}</text>
    <text x="${W / 2}" y="${H - boxH + fsBig * 1.05 + fs2 * 1.35}" font-family="Arial" font-size="${fs2}" fill="#ffe08a" text-anchor="middle">${esc(o.line2)}</text></svg>`);
  return img.composite([{ input: svg, gravity: "northwest" }]).jpeg({ quality: 88 }).toBuffer();
}

async function sendAlbum(photos: { buf: Buffer; caption: string }[]): Promise<number> {
  if (!photos.length) return 0;
  let sent = 0;
  for (let c = 0; c < photos.length; c += 10) {
    const chunk = photos.slice(c, c + 10);
    const fd = new FormData();
    fd.append("chat_id", CHAT);
    fd.append("media", JSON.stringify(chunk.map((p, i) => ({ type: "photo", media: `attach://p${i}`, caption: p.caption, parse_mode: "HTML" }))));
    chunk.forEach((p, i) => fd.append(`p${i}`, new Blob([new Uint8Array(p.buf)], { type: "image/jpeg" }), `p${i}.jpg`));
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, { method: "POST", body: fd as any });
    if ((await r.json().catch(() => null))?.ok) sent += chunk.length;
  }
  return sent;
}

const STATUS_EMOJI: Record<string, string> = { listed: "✅", crawled: "📦", allocated: "⏳" };
const STATUS_TEXT: Record<string, string> = { listed: "ĐÃ LIST", crawled: "ĐÃ CÀO", allocated: "CHƯA LIST" };

const main = async () => {
  const argv = process.argv.slice(2);
  const n = Number(argv[argv.length - 1]) > 0 ? Number(argv.pop()) : 9;
  const filterArg = ["all", "listed", "pending", "crawled", "allocated"].includes(argv[argv.length - 1]) ? argv.pop()! : "all";
  const shopArg = argv.join(" ").trim();
  if (!shopArg) return out({ ok: false, error: 'Thiếu shop. Dùng: shopStatusReport.ts "MaeBLa" pending 9' });
  if (!TOKEN || !CHAT) return out({ ok: false, error: "Thiếu TELEGRAM creds trong ~/.hermes/.env" });

  const db = new Database(path.join(process.cwd(), "data", "shein-auto.db"), { readonly: true });
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_allocation'").get()) { db.close(); return out({ ok: false, error: "Chưa có shop_allocation — chạy shopAllocate trước." }); }
  const shopRow = db.prepare("SELECT DISTINCT shop FROM shop_allocation WHERE shop LIKE '%'||?||'%' LIMIT 1").get(shopArg) as any;
  if (!shopRow) { db.close(); return out({ ok: false, error: `Shop "${shopArg}" chưa có sp phân bổ.` }); }
  const shop = shopRow.shop;

  const counts = db.prepare("SELECT SUM(status='listed') listed, SUM(status='crawled') crawled, SUM(status='allocated') allocated, COUNT(*) total FROM shop_allocation WHERE shop=?").get(shop) as any;
  const where = filterArg === "all" ? "" : filterArg === "pending" ? "AND status IN ('allocated','crawled')" : `AND status='${filterArg}'`;
  const rows = db.prepare(`
    SELECT sa.name, sa.win_score, sa.price, sa.status, sa.url, sa.image,
           rp.rating, rp.comment_num
    FROM shop_allocation sa
    LEFT JOIN (
      SELECT goods_id, rating, MAX(comment_num) as comment_num
      FROM research_product GROUP BY goods_id
    ) rp ON rp.goods_id = sa.goods_id
    WHERE sa.shop=? ${where} AND sa.status!='excluded' AND sa.image!=''
    ORDER BY sa.opportunity_score DESC LIMIT ?`).all(shop, n) as any[];
  db.close();

  const photos: { buf: Buffer; caption: string }[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const rank = idx + 1;
    try {
      const raw = Buffer.from(await (await fetch(r.image)).arrayBuffer());
      const ratingStr = r.rating ? `★${Number(r.rating).toFixed(1)}` : "";
      const commentStr = r.comment_num ? `${Number(r.comment_num) >= 1000 ? (Number(r.comment_num)/1000).toFixed(1)+"k" : r.comment_num} reviews` : "";
      const line2 = [ratingStr, commentStr].filter(Boolean).join(" · ");
      const buf = await annotate(raw, { corner: `#${rank}`, left: `$${r.price ?? "-"}`, right: `${r.win_score}`, line2 });
      const caption = `<b>#${rank}. ${esc(clean(r.name))}</b>\n win ${r.win_score} · ${ratingStr} · ${commentStr}\n🔗 ${(r.url || "").split("?")[0]}`;
      photos.push({ buf, caption });
    } catch { /* skip */ }
  }
  const sent = await sendAlbum(photos);
  out({ ok: true, shop, filter: filterArg, progress: { total: counts.total, listed: counts.listed || 0, crawled: counts.crawled || 0, chuaList: counts.allocated || 0 }, sentToTelegram: sent });
};

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }));
