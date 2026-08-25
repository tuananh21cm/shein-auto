import { describe, it, expect } from "vitest";
import { planSegments, buildFfmpegArgs, escapeFilterPath } from "./renderPlan";

describe("planSegments", () => {
  it("tổng duration trừ overlap xfade = voice + 0.8s tail; video dài có intro 3 cắt nhanh 0.9s", () => {
    const p = planSegments(6, 30000); // 6 ảnh, voice 30s → có intro
    const total = 30.8;
    const sum = p.durations.reduce((a, b) => a + b, 0);
    expect(sum - p.fade * (p.n - 1)).toBeCloseTo(total, 1);
    expect(p.n).toBe(p.durations.length);
    // 3 segment đầu = intro cắt nhanh giữ chân (0.9s), còn lại Ken Burns bình thường
    expect(p.durations.slice(0, 3)).toEqual([0.9, 0.9, 0.9]);
    for (const d of p.durations.slice(3)) { expect(d).toBeGreaterThanOrEqual(2.0); expect(d).toBeLessThanOrEqual(6.5); }
  });

  it("video ngắn (<12s) → KHÔNG intro, chia đều trong [2, 6.5]", () => {
    const p = planSegments(6, 9000); // 9.8s
    const sum = p.durations.reduce((a, b) => a + b, 0);
    expect(sum - p.fade * (p.n - 1)).toBeCloseTo(9.8, 1);
    for (const d of p.durations) { expect(d).toBeGreaterThanOrEqual(2.0); expect(d).toBeLessThanOrEqual(6.5); }
  });

  it("voice ngắn (12s) → ít segment; dài (40s) → nhiều segment", () => {
    expect(planSegments(8, 12000).n).toBeLessThan(planSegments(8, 40000).n);
  });

  it("ít ảnh hơn segment → không sao (queue sẽ lặp ảnh); n >= 2 luôn", () => {
    const p = planSegments(3, 35000);
    expect(p.n).toBeGreaterThanOrEqual(2);
  });
});

describe("escapeFilterPath", () => {
  it("đổi backslash → slash, escape dấu hai chấm cho ffmpeg filter", () => {
    expect(escapeFilterPath("C:\\data\\videos\\a.ass")).toBe("C\\:/data/videos/a.ass");
  });
});

describe("buildFfmpegArgs", () => {
  const plan = planSegments(4, 20000);
  const images = Array.from({ length: plan.n }, (_, i) => `C:\\img\\${i % 4}.jpg`);
  const base = {
    images, plan,
    voicePath: "C:\\a\\voice.mp3",
    assPath: "C:\\a\\cap.ass",
    outPath: "C:\\out\\v.mp4",
    seed: "v1",
  };

  it("đủ input ảnh + voice, filter có zoompan/xfade/ass, map vout/aout, -t đúng total", () => {
    const args = buildFfmpegArgs({ ...base, musicPath: null });
    const s = args.join(" ");
    expect(args.filter((a) => a === "-i").length).toBe(plan.n + 1); // n ảnh + voice
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect((fc.match(/zoompan/g) || []).length).toBe(plan.n);
    expect((fc.match(/xfade/g) || []).length).toBe(plan.n - 1);
    expect(fc).toContain("ass=");
    expect(fc).toContain("[vout]");
    expect(fc).toContain("[aout]");
    expect(s).toContain("-map [vout]");
    expect(s).toContain("-map [aout]");
    // -t output là cái CUỐI (mỗi input ảnh cũng có -t riêng)
    expect(args[args.lastIndexOf("-t") + 1]).toBe(plan.totalSec.toFixed(2));
    expect(args[args.length - 1]).toBe("C:\\out\\v.mp4");
  });

  it("có nhạc → thêm input stream_loop + amix; không nhạc → chỉ apad voice", () => {
    const withMusic = buildFfmpegArgs({ ...base, musicPath: "C:\\m\\bg.mp3" });
    expect(withMusic.join(" ")).toContain("-stream_loop -1");
    expect(withMusic[withMusic.indexOf("-filter_complex") + 1]).toContain("amix");
    const noMusic = buildFfmpegArgs({ ...base, musicPath: null });
    expect(noMusic[noMusic.indexOf("-filter_complex") + 1]).not.toContain("amix");
  });

  it("cùng seed → args giống hệt (deterministic)", () => {
    expect(buildFfmpegArgs({ ...base, musicPath: null })).toEqual(buildFfmpegArgs({ ...base, musicPath: null }));
  });
});
