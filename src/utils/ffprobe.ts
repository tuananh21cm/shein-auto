/**
 * Đọc duration (ms) của file audio/video bằng ffprobe (đã có trong PATH,
 * cùng bộ với ffmpeg gyan.dev full-build trên máy).
 */
import { execFile } from "child_process";

export function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe lỗi (${file}): ${err.message}`));
        const sec = parseFloat(String(stdout).trim());
        if (!isFinite(sec) || sec <= 0) return reject(new Error(`ffprobe không đọc được duration: "${stdout}"`));
        resolve(Math.round(sec * 1000));
      }
    );
  });
}
