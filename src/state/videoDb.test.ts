import { describe, it, expect } from "vitest";
import { VideoDb } from "./videoDb";

const mk = () => new VideoDb(":memory:");

describe("VideoDb", () => {
  it("create → get → status flow queued→generating→ready; lưu hook_style", () => {
    const db = mk();
    const id = db.create({ shop: "TA Shop1", productId: "P1", listingId: "L1", title: "Dress", seed: "P1:1", hookStyle: "social_proof" });
    const row = db.get(id)!;
    expect(row.status).toBe("queued");
    expect(row.product_id).toBe("P1");
    expect(row.hook_style).toBe("social_proof");
    db.setStatus(id, { status: "generating", step: "images" });
    expect(db.get(id)!.step).toBe("images");
    db.setStatus(id, { status: "ready", file: "data/videos/x.mp4" });
    expect(db.get(id)!.file).toBe("data/videos/x.mp4");
    db.close();
  });

  it("error lưu step + message, retry đưa về queued giữ nguyên script", () => {
    const db = mk();
    const id = db.create({ shop: "S", productId: "P2", listingId: "L2", title: "T", seed: "s" });
    db.setScript(id, JSON.stringify({ hook: "h" }));
    db.setStatus(id, { status: "error", step: "tts", error: "TTS timeout" });
    const row = db.get(id)!;
    expect(row.error).toBe("TTS timeout");
    db.setStatus(id, { status: "queued", error: null });
    expect(db.get(id)!.error).toBeNull();
    expect(db.get(id)!.script_json).toContain("hook");
    db.close();
  });

  it("list filter theo shop/status, hasReadyVideo, markPosted, remove", () => {
    const db = mk();
    const a = db.create({ shop: "S1", productId: "PA", listingId: "1", title: "A", seed: "a" });
    const b = db.create({ shop: "S2", productId: "PB", listingId: "2", title: "B", seed: "b" });
    db.setStatus(a, { status: "ready", file: "f.mp4" });
    expect(db.list({ shop: "S1" }).length).toBe(1);
    expect(db.list({ status: "queued" })[0].product_id).toBe("PB");
    expect(db.hasReadyVideo("PA")).toBe(true);
    expect(db.hasReadyVideo("PB")).toBe(false);
    db.markPosted(a);
    expect(db.get(a)!.status).toBe("posted");
    expect(db.hasReadyVideo("PA")).toBe(true); // posted vẫn tính là đã có video
    db.remove(b);
    expect(db.get(b)).toBeUndefined();
    db.close();
  });
});
