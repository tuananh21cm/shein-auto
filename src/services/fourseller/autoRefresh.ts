import cron from "node-cron";
import { getShopList } from "./client";
import { listAccounts } from "../../state/fourSellerAccounts";
import { getCredByUid } from "../../state/fourSellerCreds";
import { loginAndSaveCookie } from "./autoLogin";

/** Khoá tránh 2 lần re-login song song cùng 1 account. */
const reloginLocks = new Set<string>();

/**
 * Đảm bảo cookie account còn sống: ping getShopList. Hết hạn + đã lưu username/password
 * → tự login lại. Trả {refreshed, error}.
 */
export async function ensureFreshCookie(uid: string): Promise<{ refreshed: boolean; error?: string }> {
  try {
    await getShopList(`acct:${uid}`);
    return { refreshed: false }; // còn sống
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const expired = /login|validation|unauthor|401|403|expire/i.test(msg);
    if (!expired) return { refreshed: false, error: msg };
    if (reloginLocks.has(uid)) return { refreshed: false, error: "đang re-login" };
    const cred = await getCredByUid(uid);
    if (!cred?.password) return { refreshed: false, error: "cookie hết hạn — chưa lưu username/password để auto-login" };
    reloginLocks.add(uid);
    try {
      console.log(`♻️ Cookie acct:${uid} hết hạn → tự đăng nhập lại (${cred.username})…`);
      await loginAndSaveCookie(cred.username, cred.password, { headless: true, remember: true });
      return { refreshed: true };
    } catch (err: any) {
      return { refreshed: false, error: `re-login lỗi: ${err?.message ?? err}` };
    } finally {
      reloginLocks.delete(uid);
    }
  }
}

/** Ping MỌI account (ping = đánh dấu sống/chết cho banner UI + queue, xem cookieHealth);
 *  account nào hết hạn mà có creds đã lưu thì tự đăng nhập lại. */
export async function refreshAllExpired(): Promise<{ checked: number; refreshed: number }> {
  const accounts = await listAccounts();
  let refreshed = 0, checked = 0;
  for (const acc of accounts) {
    checked++;
    const r = await ensureFreshCookie(acc.uid);
    if (r.refreshed) refreshed++;
  }
  return { checked, refreshed };
}

/** Cron: định kỳ ping mọi account + re-login account có creds (mặc định mỗi 20 phút). Tắt qua env. */
export function scheduleCookieAutoRefresh(): void {
  if (process.env.DISABLE_COOKIE_AUTO_REFRESH === "1") {
    console.log("♻️ Cookie auto-refresh: TẮT (.env → DISABLE_COOKIE_AUTO_REFRESH=1)");
    return;
  }
  const expr = process.env.COOKIE_REFRESH_CRON || "*/20 * * * *";
  const run = () =>
    refreshAllExpired()
      .then((r) => { if (r.refreshed) console.log(`♻️ Cookie auto-refresh: ${r.refreshed}/${r.checked} account re-login`); })
      .catch((e) => console.warn("♻️ Cookie auto-refresh lỗi:", e?.message ?? e));
  cron.schedule(expr, run);
  setTimeout(run, 60_000); // 1 lượt ngay sau khi khởi động: banner cookie chết khỏi chờ tới 20 phút
  console.log(`♻️ Cookie auto-refresh: BẬT (${expr} · ping mọi account, re-login account có lưu user/pass)`);
}
