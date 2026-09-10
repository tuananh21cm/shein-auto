import fs from "fs-extra";
import path from "path";

/**
 * Chốt chặn CHỈ-MỘT-INSTANCE bằng file khoá kèm PID.
 *
 * Vì sao không dùng cổng: `app.listen(3000)` vốn được dùng làm chốt chặn — instance thứ hai
 * lẽ ra phải nhận EADDRINUSE rồi thoát. Nhưng đo thực tế trên Windows 10 thì instance thứ hai
 * **gọi callback thành công** và lên lịch đầy đủ cron, trong khi `netstat` cho thấy chỉ instance
 * đầu giữ cổng. Hậu quả: hai worker cùng chạy file router + queue manager + drip-publish, dẫn
 * tới đăng trùng listing.
 *
 * File khoá không phụ thuộc hành vi socket của hệ điều hành nên đáng tin hơn. Khoá cũ còn sót
 * do worker crash (PID đã chết) sẽ được tự thu hồi.
 */
const LOCK_FILE = path.join(process.cwd(), "data", "worker.lock");

interface LockInfo {
  pid: number;
  startedAt: number;
}

/** PID này còn sống không. EPERM = còn sống nhưng khác quyền → vẫn tính là sống. */
const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

const readLock = async (): Promise<LockInfo | null> => {
  try {
    const j = await fs.readJson(LOCK_FILE);
    return typeof j?.pid === "number" ? (j as LockInfo) : null;
  } catch {
    return null; // chưa có / hỏng → coi như không khoá
  }
};

/**
 * Giành khoá. Ném lỗi nếu đã có worker khác đang chạy.
 * Trả về hàm nhả khoá — gọi lúc tắt.
 */
export async function acquireInstanceLock(): Promise<() => void> {
  const prev = await readLock();
  if (prev && prev.pid !== process.pid && isAlive(prev.pid)) {
    throw new Error(
      `Đã có worker khác đang chạy (PID ${prev.pid}, từ ${new Date(prev.startedAt).toLocaleString()}). ` +
        `Tắt nó trước, hoặc xoá ${LOCK_FILE} nếu chắc chắn nó đã chết.`
    );
  }
  if (prev && !isAlive(prev.pid)) {
    console.log(`🔓 Thu hồi khoá cũ của PID ${prev.pid} (đã chết).`);
  }
  await fs.ensureDir(path.dirname(LOCK_FILE));
  await fs.writeJson(LOCK_FILE, { pid: process.pid, startedAt: Date.now() } satisfies LockInfo);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Chỉ xoá khi khoá vẫn là của mình — tránh xoá nhầm khoá instance khác vừa giành được.
    try {
      const cur = fs.readJsonSync(LOCK_FILE);
      if (cur?.pid === process.pid) fs.removeSync(LOCK_FILE);
    } catch {
      /* không có file thì thôi */
    }
  };
}
