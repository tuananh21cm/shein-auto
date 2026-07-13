/**
 * Spawn ffmpeg render 1 video. Timeout 120s (spec §6), capture stderr tail
 * làm message lỗi. ffmpeg đã có trong PATH (gyan.dev full-build).
 */
import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import { buildFfmpegArgs, FfmpegArgsOpts } from "./renderPlan";

const TIMEOUT_MS = 120_000;

export async function renderVideo(opts: FfmpegArgsOpts): Promise<string> {
  await fs.ensureDir(path.dirname(opts.outPath));
  const args = buildFfmpegArgs(opts);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += String(c); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timeout ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Không chạy được ffmpeg: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-600)}`));
    });
  });
  if (!(await fs.pathExists(opts.outPath))) throw new Error("FFmpeg xong nhưng không thấy file output");
  return opts.outPath;
}
