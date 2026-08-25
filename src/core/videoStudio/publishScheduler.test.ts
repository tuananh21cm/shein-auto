import { describe, it, expect } from "vitest";
import { decideShop, inPostingWindow, DEFAULT_SCHEDULER } from "./publishScheduler";

const cfg = DEFAULT_SCHEDULER;
const NOW = 1_800_000_000_000;
const video = { id: 7, title: "Bikini" };
const base = { shop: "S", now: NOW, hasProfile: true, nextVideo: video, cfg, jitterMin: 0 };

describe("decideShop", () => {
  it("chưa đăng gì hôm nay + có profile + có video → được đăng", () => {
    const d = decideShop({ ...base, postedToday: 0, lastPostedAt: null });
    expect(d.eligible).toBe(true);
    expect(d.video).toEqual(video);
  });

  it("đủ quota 5/ngày → chặn (reason=quota)", () => {
    const d = decideShop({ ...base, postedToday: 5, lastPostedAt: NOW - 5 * 3600_000 });
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe("quota");
  });

  it("mới đăng 30 phút trước → chặn vì chưa đủ giãn cách 2h, báo còn bao phút", () => {
    const d = decideShop({ ...base, postedToday: 1, lastPostedAt: NOW - 30 * 60_000 });
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe("gap");
    expect(d.minutesUntilNext).toBe(90); // 120 - 30
  });

  it("đăng cách đây 3h → qua giãn cách, được đăng", () => {
    const d = decideShop({ ...base, postedToday: 2, lastPostedAt: NOW - 3 * 3600_000 });
    expect(d.eligible).toBe(true);
  });

  it("jitter dương làm giãn cách dài hơn, jitter âm ngắn lại", () => {
    const lastPostedAt = NOW - 130 * 60_000; // 130 phút trước
    expect(decideShop({ ...base, postedToday: 1, lastPostedAt, jitterMin: 20 }).eligible).toBe(false); // cần 140′
    expect(decideShop({ ...base, postedToday: 1, lastPostedAt, jitterMin: -20 }).eligible).toBe(true); // cần 100′
  });

  it("chưa map Kiki profile → chặn; không còn video ready → chặn", () => {
    expect(decideShop({ ...base, postedToday: 0, lastPostedAt: null, hasProfile: false }).reason).toBe("no-profile");
    expect(decideShop({ ...base, postedToday: 0, lastPostedAt: null, nextVideo: undefined }).reason).toBe("no-video");
  });
});

describe("inPostingWindow", () => {
  const at = (h: number) => new Date(2026, 6, 13, h, 0, 0);

  it("khung VẮT QUA NỬA ĐÊM (mặc định 20h→9h = giờ vàng Mỹ): đêm OK, ban ngày VN nghỉ", () => {
    expect(inPostingWindow(at(20), cfg)).toBe(true);  // bắt đầu
    expect(inPostingWindow(at(23), cfg)).toBe(true);
    expect(inPostingWindow(at(0), cfg)).toBe(true);   // qua nửa đêm vẫn đăng
    expect(inPostingWindow(at(3), cfg)).toBe(true);
    expect(inPostingWindow(at(8), cfg)).toBe(true);
    expect(inPostingWindow(at(9), cfg)).toBe(false);  // hết khung
    expect(inPostingWindow(at(14), cfg)).toBe(false); // ban ngày VN → nghỉ
    expect(inPostingWindow(at(19), cfg)).toBe(false);
  });

  it("khung thường (from < to)", () => {
    const day = { ...cfg, hourFrom: 8, hourTo: 23 };
    expect(inPostingWindow(at(7), day)).toBe(false);
    expect(inPostingWindow(at(8), day)).toBe(true);
    expect(inPostingWindow(at(22), day)).toBe(true);
    expect(inPostingWindow(at(23), day)).toBe(false);
    expect(inPostingWindow(at(3), day)).toBe(false);
  });

  it("from === to → đăng 24/7", () => {
    const all = { ...cfg, hourFrom: 0, hourTo: 0 };
    for (const h of [0, 5, 12, 18, 23]) expect(inPostingWindow(at(h), all)).toBe(true);
  });
});
