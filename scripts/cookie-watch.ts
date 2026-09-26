/**
 * Theo dõi sống/chết cookie 4Seller: 5 phút ping 1 lần mỗi tài khoản (1 request get-tidy-list),
 * CHỈ in khi trạng thái đổi → ra mốc chết chính xác ±5 phút. Ghi thêm data/cookie-watch.jsonl.
 * Chạy: npx tsx scripts/cookie-watch.ts
 */
import fs from "fs";
import { getShopList } from "../src/services/fourseller/client";
import { listAccounts } from "../src/state/fourSellerAccounts";

const state = new Map<string, { alive: boolean; since: number; token: string }>();
const tokenOf = (uid: string) => {
  try { return String((JSON.parse(fs.readFileSync(`data/cookies/accounts/${uid}.json`, "utf8")).find((c: any) => c.name === "userToken") || {}).value || "").slice(0, 6); } catch { return "?"; }
};
const tick = async () => {
  for (const a of await listAccounts()) {
    let alive = true, err = "";
    try { await getShopList(`acct:${a.uid}`); } catch (e: any) {
      err = String(e?.message ?? e).slice(0, 80);
      // Chỉ Login.Back.* mới là cookie chết; timeout/mạng → bỏ qua lượt này, giữ trạng thái cũ.
      if (!/Login\.Back\./.test(err)) { console.log(`${new Date().toLocaleTimeString()} ${a.label}: (lỗi mạng, bỏ qua) ${err}`); continue; }
      alive = false;
    }
    const tok = tokenOf(a.uid), prev = state.get(a.uid), now = Date.now();
    if (!prev || prev.alive !== alive || prev.token !== tok) {
      const lived = prev ? ((now - prev.since) / 36e5).toFixed(1) + "h" : "-";
      const line = { at: new Date().toISOString(), acct: a.label, uid: a.uid, alive, token: tok, prevToken: prev?.token, livedHours: lived, err };
      console.log(`${new Date().toLocaleTimeString()} ${a.label}: ${alive ? "SỐNG" : "CHẾT"} · token ${tok}${prev && prev.token !== tok ? ` (đổi từ ${prev.token})` : ""}${prev ? ` · trạng thái trước kéo dài ${lived}` : ""}${err ? " · " + err : ""}`);
      fs.appendFileSync("data/cookie-watch.jsonl", JSON.stringify(line) + "\n");
      state.set(a.uid, { alive, since: now, token: tok });
    }
  }
};
(async () => { await tick(); setInterval(() => void tick().catch(() => {}), 5 * 60_000); })();
