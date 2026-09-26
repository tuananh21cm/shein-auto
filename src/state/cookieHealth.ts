/**
 * Tài khoản 4Seller nào đang chết cookie. 4Seller trả đúng mã `Login.Back.Validation_Failed`
 * cho cookie hết hạn (đo 22/09 bằng userToken giả) — client.ts đánh dấu chết khi gặp mã này,
 * đánh dấu sống lại khi có 1 request thành công (vd sau khi import cookie mới).
 * Chỉ giữ trong RAM: restart server thì lần gọi đầu tiên tự đánh dấu lại.
 */
const dead = new Map<string, number>(); // uid → lúc phát hiện chết

export const isCookieDeadError = (err: any): boolean => /Login\.Back\./.test(String(err?.message ?? err));

// Ghi lại giây phút phát hiện chết + request thành công cuối (data/cookie-deaths.jsonl) để đối chiếu với
// hoạt động của người dùng (đăng nhập trình duyệt, đổi tài khoản…) — tìm vì sao cookie chết sau ~14 giờ.
const lastOk = new Map<string, number>();
export function markCookieDead(uid: string): void {
  if (!dead.has(uid)) {
    dead.set(uid, Date.now());
    console.warn(`🍪❌ Cookie 4Seller acct:${uid} HẾT HẠN → dừng đăng các shop của tài khoản này`);
    const line = JSON.stringify({ uid, deadAt: new Date().toISOString(), lastOkAt: lastOk.has(uid) ? new Date(lastOk.get(uid)!).toISOString() : null });
    import("fs").then((fs) => fs.promises.appendFile("data/cookie-deaths.jsonl", line + "\n")).catch(() => {});
  }
}

export function markCookieAlive(uid: string): void {
  lastOk.set(uid, Date.now());
  if (dead.delete(uid)) console.log(`🍪✅ Cookie 4Seller acct:${uid} sống lại → đăng tiếp`);
}

export const deadCookies = (): { uid: string; since: number }[] => [...dead].map(([uid, since]) => ({ uid, since }));

/** Shop (folder) thuộc tài khoản đang chết cookie? → uid, không thì null. Không có ai chết → trả ngay. */
export async function deadCookieForShop(shopFolder: string): Promise<string | null> {
  if (!dead.size) return null;
  const { resolveAccountForShop } = await import("./fourSellerAccounts");
  const acc = await resolveAccountForShop(shopFolder);
  return acc && dead.has(acc.uid) ? acc.uid : null;
}
