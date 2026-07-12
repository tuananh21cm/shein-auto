# Video Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Module Video Studio trong shein-auto: đề xuất sản phẩm tiềm năng từ `listing_views` → kéo ảnh từ 4Seller → gen video TikTok 9:16 (voiceover Edge TTS + caption sync + nhạc nền, Ken Burns bằng FFmpeg) → quản lý qua admin UI.

**Architecture:** Pipeline tuần tự per-video (fetchImages → genScript → tts → buildAss → render) chạy trong in-process queue, state lưu SQLite `data/videos.db`, progress qua console.log (đã tap vào eventBus → SSE). Render bằng FFmpeg có sẵn trên máy (zoompan + xfade + ass). Spec: `docs/superpowers/specs/2026-07-13-video-studio-design.md`.

**Tech Stack:** TypeScript + tsx, better-sqlite3, sharp, axios, ffmpeg/ffprobe (đã cài trên máy, có trong PATH), Gemini (`@google/generative-ai` đã có), dependency npm mới duy nhất: `msedge-tts`. Test: vitest (colocated `*.test.ts` như codebase hiện tại).

**Quy ước chung:**
- Mọi lệnh chạy từ `C:\code\code\shein-auto`.
- Comment code bằng tiếng Việt, style ngắn gọn như codebase hiện có.
- Commit sau mỗi task, message tiếng Việt không dấu, kết thúc bằng `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File map (toàn bộ file tạo/sửa)

| File | Loại | Trách nhiệm |
|---|---|---|
| `src/core/videoStudio/rand.ts` | Create | PRNG seeded dùng chung (mulberry32) + helpers pick/shuffle |
| `src/state/videoDb.ts` | Create | SQLite store bảng `videos` (data/videos.db) |
| `src/services/tts/edgeTts.ts` | Create | Edge TTS → mp3 + word timestamps (+ fallback ước lượng) |
| `src/services/tts/estimateWords.ts` | Create | Ước lượng word timings khi TTS không trả metadata (pure) |
| `src/utils/ffprobe.ts` | Create | Đọc duration file audio/video bằng ffprobe |
| `src/services/gemini/genVideoScript.ts` | Create | Gemini gen `{hook, lines[], cta}` + validate (pure export riêng) |
| `src/core/videoStudio/buildAss.ts` | Create | Word timestamps → file .ass (caption + hook + CTA), style theo seed |
| `src/core/videoStudio/renderPlan.ts` | Create | Pure: chia segment, build ffmpeg args (zoompan/xfade/ass/audio) |
| `src/core/videoStudio/renderVideo.ts` | Create | Spawn ffmpeg, timeout, stderr capture |
| `src/core/videoStudio/fetchImages.ts` | Create | Kéo ảnh listing 4Seller → sharp 1080x1920 → remakeImage |
| `src/core/videoStudio/suggestProducts.ts` | Create | Join candidates `listing_views` với listing 4Seller active |
| `src/core/videoStudio/videoQueue.ts` | Create | Queue tuần tự chạy pipeline, resume từ step fail |
| `src/core/videoStudio/routes.ts` | Create | Express routes `/admin/api/videos/*` |
| `src/public/videos.html` | Create | UI 2 tab: Đề xuất + Thư viện |
| `src/scripts/testVideoRender.ts` | Create | Smoke test render offline (ảnh mẫu + script hardcode) |
| `src/services/tiktok/db.ts` | Modify | Thêm method `listTrackedShops()` (additive) |
| `src/adminServer.ts` | Modify | Route `/admin/videos` (sendFile) + gọi `registerVideoRoutes(app)` |
| `package.json` | Modify | Thêm dep `msedge-tts` (qua npm install) |

Test files (colocated): `rand.test.ts`, `videoDb.test.ts`, `estimateWords.test.ts`, `genVideoScript.test.ts`, `buildAss.test.ts`, `renderPlan.test.ts`, `fetchImages.test.ts`, `suggestProducts.test.ts`.

---

### Task 1: PRNG seeded dùng chung (`rand.ts`)

**Files:**
- Create: `src/core/videoStudio/rand.ts`
- Test: `src/core/videoStudio/rand.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/core/videoStudio/rand.test.ts
import { describe, it, expect } from "vitest";
import { seededRng, seededPick, seededShuffle } from "./rand";

describe("seededRng", () => {
  it("cùng seed → cùng chuỗi số, khác seed → khác", () => {
    const a1 = seededRng("abc"), a2 = seededRng("abc"), b = seededRng("xyz");
    const s1 = [a1(), a1(), a1()], s2 = [a2(), a2(), a2()], s3 = [b(), b(), b()];
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    for (const v of s1) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("seededPick / seededShuffle", () => {
  it("pick trả phần tử thuộc mảng, shuffle giữ nguyên phần tử", () => {
    const rng = seededRng("s1");
    const arr = ["a", "b", "c", "d"];
    expect(arr).toContain(seededPick(rng, arr));
    const sh = seededShuffle(seededRng("s2"), arr);
    expect(sh).not.toBe(arr);           // không mutate mảng gốc
    expect([...sh].sort()).toEqual([...arr].sort());
  });
});
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/core/videoStudio/rand.test.ts`
Expected: FAIL — "Cannot find module './rand'"

- [ ] **Step 3: Implement**

```ts
// src/core/videoStudio/rand.ts
/**
 * PRNG xác định theo seed (xfnv1a hash + mulberry32) — dùng random hóa
 * MỌI lựa chọn của 1 video (giọng, nhạc, style caption, zoom/pan, transition)
 * để re-run cùng seed ra cùng kết quả, khác seed ra video khác nhau (chống trùng).
 */
export function seededRng(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seededPick = <T>(rng: () => number, arr: T[]): T =>
  arr[Math.floor(rng() * arr.length)];

/** Fisher–Yates, KHÔNG mutate mảng gốc. */
export function seededShuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/core/videoStudio/rand.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/videoStudio/rand.ts src/core/videoStudio/rand.test.ts
git commit -m "feat(video-studio): PRNG seeded dung chung cho random hoa video

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SQLite store (`videoDb.ts`)

**Files:**
- Create: `src/state/videoDb.ts`
- Test: `src/state/videoDb.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/state/videoDb.test.ts
import { describe, it, expect } from "vitest";
import { VideoDb } from "./videoDb";

const mk = () => new VideoDb(":memory:");

describe("VideoDb", () => {
  it("create → get → status flow queued→generating→ready", () => {
    const db = mk();
    const id = db.create({ shop: "TA Shop1", productId: "P1", listingId: "L1", title: "Dress", seed: "P1:1" });
    const row = db.get(id)!;
    expect(row.status).toBe("queued");
    expect(row.product_id).toBe("P1");
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
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/state/videoDb.test.ts`
Expected: FAIL — "Cannot find module './videoDb'"

- [ ] **Step 3: Implement**

```ts
// src/state/videoDb.ts
/**
 * videoDb — state của Video Studio: mỗi row = 1 video của 1 sản phẩm.
 * Status flow: queued → generating → ready | error ; ready → posted (user đánh dấu).
 * 1 sản phẩm có thể nhiều video (regen = row mới, seed mới).
 * DB riêng data/videos.db (không đụng data/tiktok.db của crawler).
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs-extra";

const DB_PATH = path.join(process.cwd(), "data", "videos.db");

export type VideoStatus = "queued" | "generating" | "ready" | "error" | "posted";

export interface VideoRow {
  id: number;
  shop: string;
  product_id: string;
  listing_id: string;
  title: string;
  status: VideoStatus;
  step: string | null;        // step hiện tại/step fail: images|script|tts|render
  file: string | null;        // path mp4 khi ready
  script_json: string | null;
  voice: string | null;
  seed: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  posted_at: number | null;
}

export class VideoDb {
  db: Database.Database;

  constructor(file: string = DB_PATH) {
    if (file !== ":memory:") fs.ensureDirSync(path.dirname(file));
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        shop        TEXT NOT NULL,
        product_id  TEXT NOT NULL,
        listing_id  TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'queued',
        step        TEXT,
        file        TEXT,
        script_json TEXT,
        voice       TEXT,
        seed        TEXT NOT NULL,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        posted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_videos_shop ON videos(shop);
      CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
      CREATE INDEX IF NOT EXISTS idx_videos_product ON videos(product_id);
    `);
  }

  create(v: { shop: string; productId: string; listingId: string; title: string; seed: string }): number {
    const now = Date.now();
    const r = this.db.prepare(
      `INSERT INTO videos (shop, product_id, listing_id, title, seed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(v.shop, v.productId, v.listingId, v.title, v.seed, now, now);
    return Number(r.lastInsertRowid);
  }

  get(id: number): VideoRow | undefined {
    return this.db.prepare(`SELECT * FROM videos WHERE id=?`).get(id) as VideoRow | undefined;
  }

  /** Update status + các field kèm theo. error: null = xóa error cũ (retry). */
  setStatus(id: number, u: { status: VideoStatus; step?: string; error?: string | null; file?: string; voice?: string }): void {
    this.db.prepare(
      `UPDATE videos SET status=?,
         step=COALESCE(?, step),
         error=CASE WHEN ? THEN NULL ELSE COALESCE(?, error) END,
         file=COALESCE(?, file),
         voice=COALESCE(?, voice),
         updated_at=?
       WHERE id=?`
    ).run(u.status, u.step ?? null, u.error === null ? 1 : 0, u.error ?? null, u.file ?? null, u.voice ?? null, Date.now(), id);
  }

  setScript(id: number, json: string): void {
    this.db.prepare(`UPDATE videos SET script_json=?, updated_at=? WHERE id=?`).run(json, Date.now(), id);
  }

  list(f: { shop?: string; status?: string; limit?: number } = {}): VideoRow[] {
    const conds: string[] = [], args: any[] = [];
    if (f.shop) { conds.push("shop=?"); args.push(f.shop); }
    if (f.status) { conds.push("status=?"); args.push(f.status); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM videos ${where} ORDER BY id DESC LIMIT ?`
    ).all(...args, f.limit ?? 200) as VideoRow[];
  }

  /** Sản phẩm đã có video hoàn chỉnh chưa (ready hoặc posted). */
  hasReadyVideo(productId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM videos WHERE product_id=? AND status IN ('ready','posted') LIMIT 1`
    ).get(productId);
  }

  markPosted(id: number): void {
    this.db.prepare(`UPDATE videos SET status='posted', posted_at=?, updated_at=? WHERE id=?`)
      .run(Date.now(), Date.now(), id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM videos WHERE id=?`).run(id);
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/state/videoDb.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/state/videoDb.ts src/state/videoDb.test.ts
git commit -m "feat(video-studio): SQLite store videos.db (status flow, retry, posted)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: TTS — ước lượng word timings (pure) + ffprobe helper

**Files:**
- Create: `src/services/tts/estimateWords.ts`
- Create: `src/utils/ffprobe.ts`
- Test: `src/services/tts/estimateWords.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/services/tts/estimateWords.test.ts
import { describe, it, expect } from "vitest";
import { estimateWordTimings } from "./estimateWords";

describe("estimateWordTimings", () => {
  it("chia duration theo trọng số độ dài từ, phủ kín 0→duration, không chồng lấn", () => {
    const words = estimateWordTimings("Hi this is a wonderful dress", 6000);
    expect(words.map((w) => w.text)).toEqual(["Hi", "this", "is", "a", "wonderful", "dress"]);
    expect(words[0].startMs).toBe(0);
    expect(words[words.length - 1].endMs).toBe(6000);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBe(words[i - 1].endMs);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
    }
    // từ dài hơn được nhiều thời gian hơn từ 1 ký tự
    const wonderful = words[4], a = words[3];
    expect(wonderful.endMs - wonderful.startMs).toBeGreaterThan(a.endMs - a.startMs);
  });

  it("text rỗng → mảng rỗng", () => {
    expect(estimateWordTimings("   ", 3000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/services/tts/estimateWords.test.ts`
Expected: FAIL — "Cannot find module './estimateWords'"

- [ ] **Step 3: Implement estimateWords + ffprobe**

```ts
// src/services/tts/estimateWords.ts
/**
 * Fallback khi Edge TTS không trả WordBoundary metadata: ước lượng timestamp
 * từng từ bằng cách chia duration audio theo trọng số (số ký tự + 1).
 * Đủ tốt cho caption TikTok (lệch < ~200ms); có metadata thật thì không dùng.
 */
export interface TtsWord {
  text: string;
  startMs: number;
  endMs: number;
}

export function estimateWordTimings(text: string, durationMs: number): TtsWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: TtsWord[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const end = i === tokens.length - 1
      ? durationMs
      : Math.round(cursor + (weights[i] / total) * durationMs);
    out.push({ text: tokens[i], startMs: Math.round(cursor), endMs: end });
    cursor = end;
  }
  return out;
}
```

```ts
// src/utils/ffprobe.ts
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
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/services/tts/estimateWords.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/tts/estimateWords.ts src/services/tts/estimateWords.test.ts src/utils/ffprobe.ts
git commit -m "feat(video-studio): uoc luong word timings fallback + ffprobe helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Edge TTS service (`edgeTts.ts`)

**Files:**
- Modify: `package.json` (qua `npm install msedge-tts`)
- Create: `src/services/tts/edgeTts.ts`

Không unit-test phần gọi network (service free bên ngoài); phần pure (estimate) đã test ở Task 3. Verify bằng smoke script ở Task 8.

- [ ] **Step 1: Cài dependency**

Run: `npm install msedge-tts`
Expected: thêm vào `package.json` dependencies, không lỗi peer-dep.

- [ ] **Step 2: Implement**

```ts
// src/services/tts/edgeTts.ts
/**
 * Edge TTS (free, không cần API key) qua package msedge-tts.
 * Trả mp3 + word timestamps từ WordBoundary metadata; version package không
 * trả metadata → fallback estimateWordTimings (Task 3).
 *
 * Bọc sau interface TtsEngine để sau này swap OpenAI TTS chỉ sửa file này.
 */
import fs from "fs-extra";
import path from "path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { estimateWordTimings, TtsWord } from "./estimateWords";
import { probeDurationMs } from "../../utils/ffprobe";

export type { TtsWord };

export interface TtsResult {
  file: string;
  words: TtsWord[];
  durationMs: number;
}

export interface TtsEngine {
  synthesize(text: string, voice: string, outFile: string): Promise<TtsResult>;
}

/** Pool giọng en-US neural — random theo seed video ở videoQueue. */
export const VOICE_POOL = [
  "en-US-JennyNeural",
  "en-US-AriaNeural",
  "en-US-MichelleNeural",
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
];

/** Parse metadata chunk của Edge (JSON có mảng Metadata[].Type="WordBoundary"). Offset/Duration tính bằng tick 100ns. */
function parseWordBoundaries(chunks: string[]): TtsWord[] {
  const words: TtsWord[] = [];
  for (const raw of chunks) {
    try {
      const obj = JSON.parse(raw);
      for (const m of obj?.Metadata ?? []) {
        if (m?.Type !== "WordBoundary") continue;
        const d = m.Data ?? {};
        const startMs = Math.round((d.Offset ?? 0) / 10000);
        const durMs = Math.round((d.Duration ?? 0) / 10000);
        const text = d?.text?.Text ?? "";
        if (text) words.push({ text, startMs, endMs: startMs + durMs });
      }
    } catch { /* chunk không phải JSON hoàn chỉnh → bỏ */ }
  }
  return words;
}

async function synthesizeOnce(text: string, voice: string, outFile: string): Promise<TtsResult> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // toStream: version mới trả {audioStream, metadataStream}, cũ trả Readable.
  const res: any = await tts.toStream(text);
  const audioStream = res?.audioStream ?? res;
  const metadataStream = res?.metadataStream ?? null;

  const metaChunks: string[] = [];
  if (metadataStream) {
    metadataStream.on("data", (c: any) => metaChunks.push(String(c)));
    metadataStream.on("error", () => { /* metadata lỗi không chặn audio */ });
  }

  const audioBufs: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on("data", (c: Buffer) => audioBufs.push(c));
    audioStream.on("end", resolve);
    audioStream.on("error", reject);
    setTimeout(() => reject(new Error("Edge TTS timeout 60s")), 60_000).unref();
  });
  tts.close?.();

  const audio = Buffer.concat(audioBufs);
  if (audio.length < 1000) throw new Error(`Edge TTS trả audio quá ngắn (${audio.length} bytes)`);
  await fs.ensureDir(path.dirname(outFile));
  await fs.writeFile(outFile, audio);

  const durationMs = await probeDurationMs(outFile);
  let words = parseWordBoundaries(metaChunks);
  // metadata thiếu/lệch quá nhiều so với số từ thật → dùng ước lượng
  const nTokens = text.split(/\s+/).filter(Boolean).length;
  if (words.length < nTokens * 0.7) {
    console.warn(`⚠️ [TTS] WordBoundary chỉ có ${words.length}/${nTokens} từ → dùng ước lượng.`);
    words = estimateWordTimings(text, durationMs);
  }
  return { file: outFile, words, durationMs };
}

export const edgeTtsEngine: TtsEngine = {
  /** Retry 3 lần (service free chập chờn), backoff 2s/4s. */
  async synthesize(text, voice, outFile) {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await synthesizeOnce(text, voice, outFile);
      } catch (e: any) {
        lastErr = e;
        console.warn(`⚠️ [TTS] Lần ${attempt}/3 lỗi: ${e?.message ?? e}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    throw new Error(`Edge TTS thất bại sau 3 lần: ${lastErr?.message ?? lastErr}`);
  },
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Nếu lỗi type do API msedge-tts khác version (vd `setMetadata` cần 3 args, `close` không tồn tại): mở `node_modules/msedge-tts/dist/*.d.ts` đọc signature thật và chỉnh cho khớp — GIỮ nguyên hành vi defensive (audioStream ?? res, metadataStream ?? null).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/services/tts/edgeTts.ts
git commit -m "feat(video-studio): Edge TTS engine (mp3 + word timestamps, retry 3 lan)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Gemini gen script (`genVideoScript.ts`)

**Files:**
- Create: `src/services/gemini/genVideoScript.ts`
- Test: `src/services/gemini/genVideoScript.test.ts` (chỉ test hàm validate pure — không gọi API thật)

- [ ] **Step 1: Viết test fail**

```ts
// src/services/gemini/genVideoScript.test.ts
import { describe, it, expect } from "vitest";
import { validateScript, scriptToText } from "./genVideoScript";

describe("validateScript", () => {
  it("chấp nhận script hợp lệ, trim khoảng trắng", () => {
    const s = validateScript({ hook: " Stop scrolling! ", lines: ["Line one.", "Line two."], cta: "Get yours now" });
    expect(s.hook).toBe("Stop scrolling!");
    expect(s.lines).toEqual(["Line one.", "Line two."]);
  });

  it("cắt bớt khi tổng > 110 từ (giữ hook + cta, bỏ lines cuối)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `sentence number ${i} has exactly six words`);
    const s = validateScript({ hook: "Hook here", lines: long, cta: "Buy now" });
    const totalWords = scriptToText(s).split(/\s+/).length;
    expect(totalWords).toBeLessThanOrEqual(110);
    expect(s.cta).toBe("Buy now");
  });

  it("throw khi thiếu hook hoặc lines rỗng", () => {
    expect(() => validateScript({ hook: "", lines: ["x"], cta: "y" })).toThrow();
    expect(() => validateScript({ hook: "h", lines: [], cta: "y" })).toThrow();
  });
});

describe("scriptToText", () => {
  it("nối hook + lines + cta thành 1 đoạn cho TTS", () => {
    expect(scriptToText({ hook: "A.", lines: ["B.", "C."], cta: "D." })).toBe("A. B. C. D.");
  });
});
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/services/gemini/genVideoScript.test.ts`
Expected: FAIL — "Cannot find module './genVideoScript'"

- [ ] **Step 3: Implement**

```ts
// src/services/gemini/genVideoScript.ts
/**
 * Gen script video TikTok (EN) từ title sản phẩm: {hook, lines[], cta}.
 * Tổng ~70-100 từ ≈ 25-35s voiceover. Model + retry pattern giống genTitleFromShein.
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { retryGemini } from "../../utils/retryGemini";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface VideoScript {
  hook: string;
  lines: string[];
  cta: string;
}

/** Validate + chuẩn hóa output LLM. Throw nếu thiếu trường bắt buộc. */
export function validateScript(raw: any): VideoScript {
  const hook = String(raw?.hook ?? "").trim();
  const cta = String(raw?.cta ?? "").trim();
  let lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l: any) => String(l).trim()).filter(Boolean);
  if (!hook) throw new Error("Script thiếu hook");
  if (!lines.length) throw new Error("Script thiếu lines");
  if (!cta) throw new Error("Script thiếu cta");
  // Cap tổng ~110 từ: bỏ dần lines cuối (giữ hook + cta) để voiceover không quá 40s.
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let total = wc(hook) + wc(cta) + lines.reduce((a: number, l: string) => a + wc(l), 0);
  while (total > 110 && lines.length > 1) {
    total -= wc(lines[lines.length - 1]);
    lines = lines.slice(0, -1);
  }
  return { hook, lines, cta };
}

/** Text đầy đủ đưa vào TTS. */
export const scriptToText = (s: VideoScript): string =>
  [s.hook, ...s.lines, s.cta].join(" ").replace(/\s+/g, " ").trim();

export async function genVideoScript(title: string, extras?: { price?: string; attributes?: string }): Promise<VideoScript> {
  const systemInstruction = `
    You write 30-second TikTok Shop US product video voiceover scripts (2025-2026 style).
    The video shows close-up product photos with Ken Burns zoom effects.
    RULES:
    - "hook": <= 10 words, pattern-interrupt opener (question, bold claim, or "POV:"). No emoji.
    - "lines": 3-5 short spoken sentences selling the product: material/fit feel, occasions to wear, why it's trending. Casual spoken English, contractions OK.
    - "cta": <= 12 words, urgency + tap-the-cart style call to action.
    - Total across hook+lines+cta: 70-100 words (about 30 seconds spoken).
    - NO brand/supplier names (SHEIN etc.), no prices unless provided, no hashtags, no emoji.
  `;
  const prompt = `Product title: ${title}` +
    (extras?.price ? `\nPrice: ${extras.price}` : "") +
    (extras?.attributes ? `\nAttributes: ${extras.attributes}` : "");

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          hook: { type: SchemaType.STRING },
          lines: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          cta: { type: SchemaType.STRING },
        },
        required: ["hook", "lines", "cta"],
      },
    },
  });

  const result = await retryGemini(() => model.generateContent(prompt));
  return validateScript(JSON.parse(result.response.text()));
}
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/services/gemini/genVideoScript.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/gemini/genVideoScript.ts src/services/gemini/genVideoScript.test.ts
git commit -m "feat(video-studio): Gemini gen script video {hook, lines, cta} + validate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Caption ASS builder (`buildAss.ts`)

**Files:**
- Create: `src/core/videoStudio/buildAss.ts`
- Test: `src/core/videoStudio/buildAss.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/core/videoStudio/buildAss.test.ts
import { describe, it, expect } from "vitest";
import { buildAss, groupWords, msToAssTime } from "./buildAss";
import type { TtsWord } from "../../services/tts/estimateWords";

const words: TtsWord[] = [
  { text: "Stop", startMs: 0, endMs: 300 },
  { text: "scrolling", startMs: 300, endMs: 800 },
  { text: "this", startMs: 900, endMs: 1100 },
  { text: "dress", startMs: 1100, endMs: 1500 },
  { text: "is", startMs: 1500, endMs: 1600 },
  { text: "everything", startMs: 1600, endMs: 2300 },
];

describe("msToAssTime", () => {
  it("format H:MM:SS.CC", () => {
    expect(msToAssTime(0)).toBe("0:00:00.00");
    expect(msToAssTime(61230)).toBe("0:01:01.23");
    expect(msToAssTime(3600000)).toBe("1:00:00.00");
  });
});

describe("groupWords", () => {
  it("nhóm 2-4 từ, thời gian nối tiếp không chồng lấn", () => {
    const lines = groupWords(words, "seed1");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      const n = l.text.split(" ").length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
      expect(l.endMs).toBeGreaterThan(l.startMs);
    }
    for (let i = 1; i < lines.length; i++) expect(lines[i].startMs).toBeGreaterThanOrEqual(lines[i - 1].endMs);
    // ghép lại đủ mọi từ
    expect(lines.map((l) => l.text).join(" ")).toBe(words.map((w) => w.text).join(" "));
  });

  it("cùng seed cho cùng kết quả", () => {
    expect(groupWords(words, "s")).toEqual(groupWords(words, "s"));
  });
});

describe("buildAss", () => {
  it("sinh file ASS hợp lệ: header, style, hook đầu, cta cuối, caption theo timestamps", () => {
    const ass = buildAss({ words, hook: "STOP SCROLLING", cta: "Tap the cart now!", totalMs: 10000, seed: "v1" });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Caption,");
    expect(ass).toContain("Style: Hook,");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("STOP SCROLLING");
    expect(ass).toContain("Tap the cart now!");
    // caption đầu tiên bắt đầu 0:00:00.00
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,.*Caption/);
    // CTA nằm trong 3s cuối
    expect(ass).toContain(`,${msToAssTime(10000)},`);
  });

  it("escape ký tự đặc biệt ASS trong text ({, }, \\n)", () => {
    const ass = buildAss({
      words: [{ text: "50%", startMs: 0, endMs: 500 }],
      hook: "Deal {today}", cta: "Now\\here", totalMs: 3000, seed: "x",
    });
    expect(ass).not.toContain("{today}");   // { } phải bị escape/loại
  });
});
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/core/videoStudio/buildAss.test.ts`
Expected: FAIL — "Cannot find module './buildAss'"

- [ ] **Step 3: Implement**

```ts
// src/core/videoStudio/buildAss.ts
/**
 * Build file .ass: caption sync theo word timestamps (nhóm 2-4 từ/dòng),
 * hook overlay ~2s đầu, CTA 2.5s cuối. Style chọn theo seed từ 5 preset
 * (font/màu/viền) — font hệ thống Windows, không bundle.
 * Dùng .ass thay drawtext để khỏi escape text trong filtergraph ffmpeg.
 */
import { seededRng, seededPick } from "./rand";
import type { TtsWord } from "../../services/tts/estimateWords";

export interface CaptionLine { text: string; startMs: number; endMs: number }

export const msToAssTime = (ms: number): string => {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
};

/** {} là control code của ASS, \ bắt đầu override → thay bằng ký tự an toàn. */
const escapeAss = (s: string): string =>
  s.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, " ");

/** Nhóm 2-4 từ thành 1 dòng caption (kích thước nhóm random theo seed). */
export function groupWords(words: TtsWord[], seed: string): CaptionLine[] {
  const rng = seededRng(`grp:${seed}`);
  const lines: CaptionLine[] = [];
  let i = 0;
  while (i < words.length) {
    const size = Math.min(2 + Math.floor(rng() * 3), words.length - i); // 2-4
    const grp = words.slice(i, i + size);
    lines.push({
      text: grp.map((w) => w.text).join(" "),
      startMs: grp[0].startMs,
      endMs: grp[grp.length - 1].endMs,
    });
    i += size;
  }
  // kéo endMs của dòng tới startMs dòng sau (đỡ nháy giữa các dòng), không chồng lấn
  for (let k = 0; k < lines.length - 1; k++) lines[k].endMs = Math.max(lines[k].endMs, lines[k + 1].startMs);
  return lines;
}

interface StylePreset { name: string; caption: string; hook: string }

/** PrimaryColour ASS = &HAABBGGRR (AA=00 đục). 5 preset đổi font/màu chống trùng template. */
const STYLE_PRESETS: StylePreset[] = [
  { name: "white-impact",
    caption: `Style: Caption,Impact,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,640,1`,
    hook:    `Style: Hook,Impact,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
  { name: "yellow-arialblack",
    caption: `Style: Caption,Arial Black,84,&H0000FFFF,&H0000FFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,640,1`,
    hook:    `Style: Hook,Arial Black,96,&H0000FFFF,&H0000FFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
  { name: "white-verdana-pink",
    caption: `Style: Caption,Verdana,80,&H00FFFFFF,&H00FFFFFF,&H00B469FF,&H7F000000,-1,0,0,0,100,100,0,0,1,7,0,2,60,60,660,1`,
    hook:    `Style: Hook,Verdana,92,&H00FFFFFF,&H00FFFFFF,&H00B469FF,&H7F000000,-1,0,0,0,100,100,0,0,1,8,0,8,60,60,300,1` },
  { name: "black-on-white-tahoma",
    caption: `Style: Caption,Tahoma,80,&H00000000,&H00000000,&H00FFFFFF,&H7F000000,-1,0,0,0,100,100,0,0,3,8,0,2,60,60,640,1`,
    hook:    `Style: Hook,Tahoma,92,&H00000000,&H00000000,&H00FFFFFF,&H7F000000,-1,0,0,0,100,100,0,0,3,9,0,8,60,60,300,1` },
  { name: "mint-segoe",
    caption: `Style: Caption,Segoe UI Black,82,&H00C4F5D8,&H00C4F5D8,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,650,1`,
    hook:    `Style: Hook,Segoe UI Black,94,&H00C4F5D8,&H00C4F5D8,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,2,8,60,60,300,1` },
];

export function buildAss(opts: {
  words: TtsWord[];
  hook: string;
  cta: string;
  totalMs: number;
  seed: string;
}): string {
  const preset = seededPick(seededRng(`style:${opts.seed}`), STYLE_PRESETS);
  const lines = groupWords(opts.words, opts.seed);

  const events: string[] = [];
  // Hook overlay 0 → min(2200ms, 1/4 video)
  const hookEnd = Math.min(2200, Math.round(opts.totalMs / 4));
  events.push(`Dialogue: 0,${msToAssTime(0)},${msToAssTime(hookEnd)},Hook,,0,0,0,,${escapeAss(opts.hook.toUpperCase())}`);
  // Caption theo timestamps
  for (const l of lines) {
    events.push(`Dialogue: 0,${msToAssTime(l.startMs)},${msToAssTime(l.endMs)},Caption,,0,0,0,,${escapeAss(l.text)}`);
  }
  // CTA 2.5s cuối
  const ctaStart = Math.max(0, opts.totalMs - 2500);
  events.push(`Dialogue: 0,${msToAssTime(ctaStart)},${msToAssTime(opts.totalMs)},Hook,,0,0,0,,${escapeAss(opts.cta)}`);

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    preset.caption,
    preset.hook,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/core/videoStudio/buildAss.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/videoStudio/buildAss.ts src/core/videoStudio/buildAss.test.ts
git commit -m "feat(video-studio): ASS caption builder (sync word timestamps, 5 style preset)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Render plan + FFmpeg args (`renderPlan.ts`, pure)

**Files:**
- Create: `src/core/videoStudio/renderPlan.ts`
- Test: `src/core/videoStudio/renderPlan.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/core/videoStudio/renderPlan.test.ts
import { describe, it, expect } from "vitest";
import { planSegments, buildFfmpegArgs, escapeFilterPath } from "./renderPlan";

describe("planSegments", () => {
  it("tổng duration trừ overlap xfade = voice + 0.8s tail", () => {
    const p = planSegments(6, 30000); // 6 ảnh, voice 30s
    const total = 30.8;
    const sum = p.durations.reduce((a, b) => a + b, 0);
    expect(sum - p.fade * (p.n - 1)).toBeCloseTo(total, 1);
    expect(p.n).toBe(p.durations.length);
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
    expect(args[args.indexOf("-t") + 1]).toBe(plan.totalSec.toFixed(2));
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
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/core/videoStudio/renderPlan.test.ts`
Expected: FAIL — "Cannot find module './renderPlan'"

- [ ] **Step 3: Implement**

```ts
// src/core/videoStudio/renderPlan.ts
/**
 * Pure logic render: chia video thành N segment ảnh (Ken Burns) nối bằng xfade,
 * và build args ffmpeg hoàn chỉnh. Tách pure để unit-test không cần chạy ffmpeg.
 *
 * Cấu trúc filtergraph:
 *   mỗi ảnh: scale 2x → zoompan (chống jitter) → 1080x1920@30fps
 *   nối: xfade dây chuyền, offset_m = sum(d_0..d_{m-1}) − m·fade
 *   cuối: ass=caption, format=yuv420p
 *   audio: voice apad tới total (+ nhạc nền loop, volume 0.18, amix)
 */
import { seededRng, seededPick } from "./rand";

export interface SegmentPlan {
  n: number;            // số segment
  durations: number[];  // giây, gross (đã gồm phần overlap fade)
  fade: number;         // giây
  totalSec: number;     // duration video cuối
}

const FADE = 0.4;
const TARGET_SEG = 3.5;   // giây/ảnh lý tưởng
const MIN_SEG = 2.0;
const MAX_SEG = 6.5;

export function planSegments(imageCount: number, voiceMs: number): SegmentPlan {
  const totalSec = voiceMs / 1000 + 0.8; // tail 0.8s sau khi voice hết
  let n = Math.max(2, Math.round(totalSec / TARGET_SEG));
  // gross mỗi segment = (total + fade*(n-1)) / n — chỉnh n để nằm trong [MIN,MAX]
  const gross = (k: number) => (totalSec + FADE * (k - 1)) / k;
  while (n > 2 && gross(n) < MIN_SEG) n--;
  while (gross(n) > MAX_SEG) n++;
  const d = gross(n);
  return { n, durations: Array.from({ length: n }, () => Math.round(d * 100) / 100), fade: FADE, totalSec: Math.round(totalSec * 100) / 100 };
}

/** Path Windows → dạng ffmpeg filter chấp nhận: slash + escape ':'. */
export const escapeFilterPath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/:/g, "\\:");

const XFADE_TRANSITIONS = ["fade", "slideleft", "slideright", "slideup", "smoothleft", "smoothright"];

/** 4 biến thể Ken Burns; chọn theo seed từng segment. */
const KENBURNS = [
  // zoom in giữa
  (f: number) => `z='min(1+0.12*on/${f},1.12)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom out giữa
  (f: number) => `z='max(1.12-0.12*on/${f},1.001)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trái→phải
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)*on/${f}':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trên→dưới
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*on/${f}'`,
];

export interface FfmpegArgsOpts {
  images: string[];          // đúng plan.n phần tử (queue đã lặp/cắt sẵn)
  plan: SegmentPlan;
  voicePath: string;
  musicPath: string | null;
  assPath: string;
  outPath: string;
  seed: string;
}

export function buildFfmpegArgs(o: FfmpegArgsOpts): string[] {
  const { plan } = o;
  if (o.images.length !== plan.n) throw new Error(`images (${o.images.length}) phải = plan.n (${plan.n})`);
  const rng = seededRng(`render:${o.seed}`);
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

  // Inputs: n ảnh loop
  for (let i = 0; i < plan.n; i++) {
    args.push("-loop", "1", "-t", plan.durations[i].toFixed(2), "-i", o.images[i]);
  }
  const voiceIdx = plan.n;
  args.push("-i", o.voicePath);
  let musicIdx = -1;
  if (o.musicPath) {
    musicIdx = plan.n + 1;
    args.push("-stream_loop", "-1", "-i", o.musicPath);
  }

  // Video chains
  const parts: string[] = [];
  for (let i = 0; i < plan.n; i++) {
    const frames = Math.max(1, Math.round(plan.durations[i] * 30));
    const kb = seededPick(rng, KENBURNS)(frames);
    parts.push(
      `[${i}:v]scale=2160:3840:flags=lanczos,zoompan=${kb}:d=${frames}:s=1080x1920:fps=30,settb=AVTB[v${i}]`
    );
  }
  // xfade chain: offset_m = sum(d_0..d_{m-1}) − m·fade
  let prev = "v0";
  let cum = 0;
  for (let m = 1; m < plan.n; m++) {
    cum += plan.durations[m - 1];
    const offset = (cum - m * plan.fade).toFixed(2);
    const tr = seededPick(rng, XFADE_TRANSITIONS);
    const outLbl = m === plan.n - 1 ? "vx" : `x${m}`;
    parts.push(`[${prev}][v${m}]xfade=transition=${tr}:duration=${plan.fade}:offset=${offset}[${outLbl}]`);
    prev = outLbl;
  }
  const vsrc = plan.n === 1 ? "v0" : "vx";
  parts.push(`[${vsrc}]ass='${escapeFilterPath(o.assPath)}',format=yuv420p[vout]`);

  // Audio
  const T = plan.totalSec.toFixed(2);
  if (musicIdx >= 0) {
    parts.push(
      `[${voiceIdx}:a]apad=whole_dur=${T}[va]`,
      `[${musicIdx}:a]volume=0.18,afade=t=out:st=${Math.max(0, plan.totalSec - 1.2).toFixed(2)}:d=1.2[ma]`,
      `[va][ma]amix=inputs=2:duration=first:normalize=0[aout]`
    );
  } else {
    parts.push(`[${voiceIdx}:a]apad=whole_dur=${T}[aout]`);
  }

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", T,
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    o.outPath
  );
  return args;
}
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `npx vitest run src/core/videoStudio/renderPlan.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/videoStudio/renderPlan.ts src/core/videoStudio/renderPlan.test.ts
git commit -m "feat(video-studio): segment plan + ffmpeg args builder (zoompan/xfade/ass)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: FFmpeg runner + smoke test render thật

**Files:**
- Create: `src/core/videoStudio/renderVideo.ts`
- Create: `src/scripts/testVideoRender.ts`

- [ ] **Step 1: Implement runner**

```ts
// src/core/videoStudio/renderVideo.ts
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
```

- [ ] **Step 2: Viết smoke script**

Ảnh mẫu có sẵn trong repo: `src/core/steps/temp_images_a6e6dd02e280840e/img_0.jpg`, `img_1.jpg`, `img_2.jpg`.

```ts
// src/scripts/testVideoRender.ts
/**
 * Smoke test Video Studio KHÔNG cần 4Seller/Gemini: ảnh mẫu trong repo +
 * script hardcode + Edge TTS thật + render ffmpeg thật.
 * Usage: npx tsx src/scripts/testVideoRender.ts [--no-tts]
 *   --no-tts: bỏ qua Edge TTS (offline), dùng words ước lượng trên audio im lặng.
 */
import "dotenv/config";
import path from "path";
import fs from "fs-extra";
import { execFile } from "child_process";
import { edgeTtsEngine, VOICE_POOL } from "../services/tts/edgeTts";
import { estimateWordTimings } from "../services/tts/estimateWords";
import { scriptToText, VideoScript } from "../services/gemini/genVideoScript";
import { buildAss } from "../core/videoStudio/buildAss";
import { planSegments } from "../core/videoStudio/renderPlan";
import { renderVideo } from "../core/videoStudio/renderVideo";
import { seededRng, seededShuffle, seededPick } from "../core/videoStudio/rand";

const SAMPLE_DIR = path.resolve(process.cwd(), "src", "core", "steps", "temp_images_a6e6dd02e280840e");
const OUT_DIR = path.resolve(process.cwd(), "data", "videos", "_smoke");

const SCRIPT: VideoScript = {
  hook: "POV: you found the perfect summer dress",
  lines: [
    "The fabric is so soft it feels like a cloud.",
    "That ruched waist? Flattering on literally everyone.",
    "Wear it to brunch, the beach, or date night.",
  ],
  cta: "Tap the cart before it sells out!",
};

const makeSilence = (file: string, sec: number) =>
  new Promise<void>((res, rej) =>
    execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", String(sec), file],
      (e) => (e ? rej(e) : res())));

const main = async () => {
  const noTts = process.argv.includes("--no-tts");
  const seed = "smoke:1";
  await fs.ensureDir(OUT_DIR);

  const images = (await fs.readdir(SAMPLE_DIR)).filter((f) => /^img_\d+\.jpg$/.test(f)).map((f) => path.join(SAMPLE_DIR, f));
  if (images.length < 3) throw new Error(`Cần ≥3 ảnh mẫu trong ${SAMPLE_DIR}`);
  console.log(`🖼️ ${images.length} ảnh mẫu`);

  const text = scriptToText(SCRIPT);
  const voicePath = path.join(OUT_DIR, "voice.mp3");
  let words, durationMs;
  if (noTts) {
    durationMs = 20000;
    await makeSilence(voicePath, durationMs / 1000);
    words = estimateWordTimings(text, durationMs);
    console.log("🔇 --no-tts: audio im lặng 20s + words ước lượng");
  } else {
    const voice = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
    console.log(`🎙️ Edge TTS voice=${voice}…`);
    const r = await edgeTtsEngine.synthesize(text, voice, voicePath);
    words = r.words; durationMs = r.durationMs;
    console.log(`   ${Math.round(durationMs / 1000)}s audio, ${words.length} words`);
  }

  const plan = planSegments(images.length, durationMs);
  const ordered = seededShuffle(seededRng(`order:${seed}`), images);
  const segImages = Array.from({ length: plan.n }, (_, i) => ordered[i % ordered.length]);

  const assPath = path.join(OUT_DIR, "captions.ass");
  await fs.writeFile(assPath, buildAss({ words, hook: SCRIPT.hook, cta: SCRIPT.cta, totalMs: Math.round(plan.totalSec * 1000), seed }), "utf-8");

  const outPath = path.join(OUT_DIR, "smoke.mp4");
  console.log(`🎬 Render ${plan.n} segments, ${plan.totalSec}s…`);
  const t0 = Date.now();
  await renderVideo({ images: segImages, plan, voicePath, musicPath: null, assPath, outPath, seed });
  console.log(`✅ Xong sau ${Math.round((Date.now() - t0) / 1000)}s → ${outPath}`);
};

main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 3: Chạy smoke test offline trước**

Run: `npx tsx src/scripts/testVideoRender.ts --no-tts`
Expected: `✅ Xong sau Ns → ...data\videos\_smoke\smoke.mp4`. Nếu FFmpeg exit ≠ 0: đọc stderr trong message — lỗi thường gặp là filtergraph syntax hoặc font ASS; sửa `renderPlan.ts`/`buildAss.ts` cho tới khi render được, chạy lại unit tests sau khi sửa.

- [ ] **Step 4: Chạy smoke test với TTS thật**

Run: `npx tsx src/scripts/testVideoRender.ts`
Expected: log số words từ TTS, render OK. Nếu Edge TTS lỗi 403/timeout cả 3 lần: kiểm tra version msedge-tts mới nhất (`npm view msedge-tts version`), upgrade nếu cần. Đây là điểm rủi ro đã ghi ở spec §8.

- [ ] **Step 5: Mở file `data/videos/_smoke/smoke.mp4` xem bằng mắt** — caption hiện đúng nhịp, zoom mượt, đủ 9:16. Chỉnh style/tham số nếu thấy xấu rõ ràng.

- [ ] **Step 6: Commit**

```bash
git add src/core/videoStudio/renderVideo.ts src/scripts/testVideoRender.ts
git commit -m "feat(video-studio): ffmpeg runner + smoke test render that

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Kéo ảnh từ 4Seller (`fetchImages.ts`)

**Files:**
- Create: `src/core/videoStudio/fetchImages.ts`
- Test: `src/core/videoStudio/fetchImages.test.ts` (chỉ test pure `extractImageUrls`)

- [ ] **Step 1: Viết test fail**

```ts
// src/core/videoStudio/fetchImages.test.ts
import { describe, it, expect } from "vitest";
import { extractImageUrls } from "./fetchImages";

describe("extractImageUrls", () => {
  it("detail.images là mảng string", () => {
    expect(extractImageUrls({ images: ["http://a/1.jpg", "http://a/2.jpg"] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images là mảng object {url} hoặc {imgUrl}", () => {
    expect(extractImageUrls({ images: [{ url: "http://a/1.jpg" }, { imgUrl: "http://a/2.jpg" }] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images là chuỗi phân cách '|'", () => {
    expect(extractImageUrls({ images: "http://a/1.jpg|http://a/2.jpg" }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("fallback mainImage khi detail không có ảnh; dedup; bỏ chuỗi rỗng", () => {
    expect(extractImageUrls({}, "http://a/1.jpg|http://a/1.jpg||http://a/2.jpg"))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("không có gì → mảng rỗng", () => {
    expect(extractImageUrls(null, undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `npx vitest run src/core/videoStudio/fetchImages.test.ts`
Expected: FAIL — "Cannot find module './fetchImages'"

- [ ] **Step 3: Implement**

```ts
// src/core/videoStudio/fetchImages.ts
/**
 * Kéo ảnh sản phẩm từ 4Seller cho 1 video:
 *   getListingDetail → images[] → download (cache theo productId)
 *   → sharp cover-crop 1080x1920 (position attention) → remakeImage chống trùng
 * Ảnh gốc cache ở assets/<productId>/src_N.jpg (dùng chung mọi video),
 * ảnh đã xử lý ở assets/<productId>/<videoId>/img_N.jpg (per-video vì seed khác).
 */
import axios from "axios";
import fs from "fs-extra";
import path from "path";
import sharp from "sharp";
import { getListingDetail } from "../../services/fourseller/client";
import { remakeImage } from "../../utils/remakeImage";

const ASSETS_DIR = path.resolve(process.cwd(), "data", "videos", "assets");
const MAX_IMAGES = 8;
const MIN_IMAGES = 3;

/** Bóc URL ảnh từ detail 4Seller (mảng string / mảng object / chuỗi '|'), fallback mainImage của list record. */
export function extractImageUrls(detail: any, mainImage?: string): string[] {
  const urls: string[] = [];
  const push = (v: any) => {
    const u = typeof v === "string" ? v : v?.url ?? v?.imgUrl ?? v?.image ?? "";
    if (u && typeof u === "string") urls.push(u.trim());
  };
  const imgs = detail?.images;
  if (Array.isArray(imgs)) imgs.forEach(push);
  else if (typeof imgs === "string" && imgs) imgs.split("|").forEach(push);
  if (!urls.length && mainImage) mainImage.split("|").forEach(push);
  return [...new Set(urls.filter(Boolean))];
}

async function downloadTo(url: string, file: string): Promise<void> {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0" } });
  await fs.writeFile(file, new Uint8Array(Buffer.from(res.data)));
}

export interface FetchImagesResult { files: string[]; dir: string }

export async function fetchImages(opts: {
  principal: string;
  listingId: string;
  productId: string;
  videoId: number;
  seed: string;
  mainImage?: string;
}): Promise<FetchImagesResult> {
  const srcDir = path.join(ASSETS_DIR, opts.productId);
  const outDir = path.join(srcDir, String(opts.videoId));
  await fs.ensureDir(outDir);

  // Ảnh đã xử lý đủ từ lần chạy trước (retry) → tái dùng
  const existing = (await fs.readdir(outDir)).filter((f) => /^img_\d+\.jpg$/.test(f)).sort();
  if (existing.length >= MIN_IMAGES) {
    return { files: existing.map((f) => path.join(outDir, f)), dir: outDir };
  }

  // 1. Lấy URL ảnh (cache src trước, chỉ gọi API khi cache thiếu)
  let srcFiles = (await fs.pathExists(srcDir))
    ? (await fs.readdir(srcDir)).filter((f) => /^src_\d+\.jpg$/.test(f)).sort().map((f) => path.join(srcDir, f))
    : [];
  if (srcFiles.length < MIN_IMAGES) {
    const detail = await getListingDetail(opts.principal, opts.listingId).catch((e) => {
      console.warn(`⚠️ [Images] getListingDetail lỗi: ${e?.message} → thử mainImage`);
      return null;
    });
    const urls = extractImageUrls(detail, opts.mainImage).slice(0, MAX_IMAGES);
    if (urls.length < MIN_IMAGES) throw new Error(`Chỉ tìm thấy ${urls.length} ảnh (cần ≥${MIN_IMAGES})`);
    await fs.ensureDir(srcDir);
    srcFiles = [];
    let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      const f = path.join(srcDir, `src_${i}.jpg`);
      try {
        if (!(await fs.pathExists(f))) await downloadTo(urls[i], f);
        srcFiles.push(f);
      } catch (e: any) {
        failed++;
        console.warn(`⚠️ [Images] Tải ảnh ${i} lỗi: ${e?.message}`);
      }
    }
    if (srcFiles.length < MIN_IMAGES) throw new Error(`Tải được ${srcFiles.length}/${urls.length} ảnh (lỗi ${failed}), cần ≥${MIN_IMAGES}`);
  }

  // 2. Cover-crop 1080x1920 + remake chống trùng (seed per-video per-ảnh)
  const files: string[] = [];
  for (let i = 0; i < Math.min(srcFiles.length, MAX_IMAGES); i++) {
    const tmp = path.join(outDir, `tmp_${i}.jpg`);
    const out = path.join(outDir, `img_${i}.jpg`);
    await sharp(srcFiles[i])
      .resize({ width: 1080, height: 1920, fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 92 })
      .toFile(tmp);
    await remakeImage(tmp, out, { preset: "standard", seed: `${opts.seed}:${i}` });
    await fs.remove(tmp);
    files.push(out);
  }
  return { files, dir: outDir };
}
```

- [ ] **Step 4: Chạy test + typecheck — phải PASS**

Run: `npx vitest run src/core/videoStudio/fetchImages.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck sạch. Nếu `sharp.strategy.attention` sai type: dùng `position: "attention"`.

- [ ] **Step 5: Commit**

```bash
git add src/core/videoStudio/fetchImages.ts src/core/videoStudio/fetchImages.test.ts
git commit -m "feat(video-studio): keo anh 4Seller + sharp 9:16 + remake chong trung

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Đề xuất sản phẩm (`suggestProducts.ts` + `listTrackedShops`)

**Files:**
- Modify: `src/services/tiktok/db.ts` (thêm method trước `close()`)
- Create: `src/core/videoStudio/suggestProducts.ts`
- Test: `src/core/videoStudio/suggestProducts.test.ts` (test pure join)

- [ ] **Step 1: Thêm `listTrackedShops` vào TiktokDb**

Trong `src/services/tiktok/db.ts`, thêm method ngay TRƯỚC `close(): void {`:

```ts
  /** Danh sách shop có data listing_views (dropdown Video Studio). */
  listTrackedShops(): string[] {
    return (this.db
      .prepare(`SELECT DISTINCT shop FROM listing_views WHERE shop != '' ORDER BY shop`)
      .all() as { shop: string }[]).map((r) => r.shop);
  }
```

- [ ] **Step 2: Viết test fail cho join**

```ts
// src/core/videoStudio/suggestProducts.test.ts
import { describe, it, expect } from "vitest";
import { joinCandidatesWithListings } from "./suggestProducts";

const cands = [
  { productId: "P1", productName: "Dress A", pv: 900, avgPerDay: 40, daysTracked: 5, orders: 3, stock: 10, converting: true, reasons: ["có đơn"] },
  { productId: "P2", productName: "Top B", pv: 600, avgPerDay: 25, daysTracked: 4, orders: 0, stock: 5, converting: false, reasons: ["đang lên"] },
  { productId: "P404", productName: "Gone", pv: 100, avgPerDay: 20, daysTracked: 3, orders: 0, stock: 1, converting: false, reasons: ["đang lên"] },
];
const listingIndex = new Map([
  ["P1", { listingId: "L1", title: "Dress A full", mainImage: "http://i/1.jpg|http://i/2.jpg" }],
  ["P2", { listingId: "L2", title: "Top B full", mainImage: "http://i/3.jpg" }],
]);

describe("joinCandidatesWithListings", () => {
  it("match theo productId, lấy listingId + thumb (ảnh đầu của mainImage)", () => {
    const { items, unmatched } = joinCandidatesWithListings(cands as any, listingIndex);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ productId: "P1", listingId: "L1", thumb: "http://i/1.jpg", reasons: ["có đơn"] });
    expect(unmatched).toBe(1); // P404 không còn active trên 4Seller
  });
});
```

Run: `npx vitest run src/core/videoStudio/suggestProducts.test.ts`
Expected: FAIL — "Cannot find module './suggestProducts'"

- [ ] **Step 3: Implement**

```ts
// src/core/videoStudio/suggestProducts.ts
/**
 * Đề xuất sản phẩm làm video: candidates tín hiệu view/sold từ listing_views
 * (getFlashCandidates — có đơn / đang lên / nhiều view, kèm reasons) JOIN với
 * listing active trên 4Seller (lấy listingId + mainImage). Pattern principal
 * + shopId GIỐNG flashDeal.ts.
 */
import { getShopList, getListingPage } from "../../services/fourseller/client";
import { resolveAccountForShop } from "../../state/fourSellerAccounts";
import { TiktokDb } from "../../services/tiktok/db";
import { VideoDb } from "../../state/videoDb";

export interface SuggestItem {
  productId: string; listingId: string; title: string; thumb: string;
  pv: number; avgPerDay: number; orders: number; daysTracked: number;
  reasons: string[]; hasVideo: boolean;
}

export interface ListingLite { listingId: string; title: string; mainImage: string }

/** Pure join để unit-test: candidates × index(productId→listing). */
export function joinCandidatesWithListings(
  candidates: { productId: string; productName: string; pv: number; avgPerDay: number; daysTracked: number; orders: number; reasons: string[] }[],
  index: Map<string, ListingLite>
): { items: Omit<SuggestItem, "hasVideo">[]; unmatched: number } {
  const items: Omit<SuggestItem, "hasVideo">[] = [];
  let unmatched = 0;
  for (const c of candidates) {
    const l = index.get(String(c.productId));
    if (!l) { unmatched++; continue; }
    items.push({
      productId: String(c.productId), listingId: String(l.listingId),
      title: l.title || c.productName,
      thumb: (l.mainImage || "").split("|")[0] ?? "",
      pv: c.pv, avgPerDay: c.avgPerDay, orders: c.orders, daysTracked: c.daysTracked,
      reasons: c.reasons,
    });
  }
  return { items, unmatched };
}

export async function suggestProducts(shop: string, opts: { limit?: number } = {}): Promise<{
  shop: string; latestDate: string | null; items: SuggestItem[]; unmatched: number;
}> {
  const limit = opts.limit ?? 50;

  // 1. Principal + shopId (giống flashDeal)
  const account = await resolveAccountForShop(shop);
  if (!account) throw new Error(`Shop "${shop}" không thuộc tài khoản 4Seller nào (tab Cookie 4Seller).`);
  const principal = `acct:${account.uid}`;
  const shopList = await getShopList(principal);
  const rec = (shopList?.records ?? []).find((s: any) => s.shopName === shop);
  if (!rec) throw new Error(`Không thấy shop "${shop}" trong 4Seller (tài khoản ${account.label}).`);
  const shopId = Number(rec.id);

  // 2. Candidates từ tín hiệu view/sold
  const tdb = new TiktokDb();
  let cand;
  try { cand = tdb.getFlashCandidates(shop, { limit }); } finally { tdb.close(); }
  if (!cand.candidates.length) return { shop, latestDate: cand.latestDate, items: [], unmatched: 0 };

  // 3. Index listing active theo productId (paginate hết)
  const index = new Map<string, ListingLite>();
  for (let page = 1; page <= 20; page++) {
    const res = await getListingPage(principal, { shopId, status: "active", pageCurrent: page, pageSize: 100 });
    for (const r of res.records ?? []) {
      index.set(String(r.productId), {
        listingId: String(r.id),
        title: String(r.title ?? r.productName ?? ""),
        mainImage: String(r.mainImage ?? ""),
      });
    }
    if ((res.records?.length ?? 0) < 100 || index.size >= (res.total ?? 0)) break;
  }

  // 4. Join + cờ hasVideo
  const { items, unmatched } = joinCandidatesWithListings(cand.candidates, index);
  if (unmatched) console.warn(`⚠️ [Suggest] ${unmatched} sp có tín hiệu nhưng không còn active trên 4Seller (${shop})`);
  const vdb = new VideoDb();
  try {
    return {
      shop, latestDate: cand.latestDate, unmatched,
      items: items.map((it) => ({ ...it, hasVideo: vdb.hasReadyVideo(it.productId) })),
    };
  } finally { vdb.close(); }
}
```

- [ ] **Step 4: Chạy test + typecheck — phải PASS**

Run: `npx vitest run src/core/videoStudio/suggestProducts.test.ts && npm run typecheck`
Expected: PASS (1 test), typecheck sạch. Lưu ý: field title của ListingRecord có thể tên khác (`productName`) — code đã fallback cả 2; nếu typecheck báo field không tồn tại trên ListingRecord thì record là `[k: string]: any` nên vẫn pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/tiktok/db.ts src/core/videoStudio/suggestProducts.ts src/core/videoStudio/suggestProducts.test.ts
git commit -m "feat(video-studio): de xuat san pham tiem nang (join listing_views x 4Seller)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Queue pipeline (`videoQueue.ts`)

**Files:**
- Create: `src/core/videoStudio/videoQueue.ts`

Orchestration mỏng — mọi logic đã test ở các task trước. Verify qua route + UI (Task 12) và smoke ở Task 8.

- [ ] **Step 1: Implement**

```ts
// src/core/videoStudio/videoQueue.ts
/**
 * Queue tuần tự Video Studio (1 render 1 lúc — ffmpeg ăn full CPU).
 * Pipeline per video: images → script → tts → render. Artifacts trên disk
 * (ảnh/script/voice) tái dùng khi retry — chạy lại từ step fail.
 * Progress qua console.log (đã tap vào eventBus → SSE của admin).
 */
import fs from "fs-extra";
import path from "path";
import { VideoDb } from "../../state/videoDb";
import { resolveAccountForShop } from "../../state/fourSellerAccounts";
import { fetchImages } from "./fetchImages";
import { genVideoScript, scriptToText, validateScript, VideoScript } from "../../services/gemini/genVideoScript";
import { edgeTtsEngine, VOICE_POOL } from "../../services/tts/edgeTts";
import { buildAss } from "./buildAss";
import { planSegments } from "./renderPlan";
import { renderVideo } from "./renderVideo";
import { seededRng, seededPick, seededShuffle } from "./rand";

const VIDEOS_DIR = path.resolve(process.cwd(), "data", "videos");
const MUSIC_DIR = path.join(VIDEOS_DIR, "music");
const ASSETS_DIR = path.join(VIDEOS_DIR, "assets");

export interface CreateVideoItem { productId: string; listingId: string; title: string; mainImage?: string }

const safeName = (s: string) => s.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "shop";

class VideoQueue {
  private running = false;

  /** Tạo rows queued + kick worker. Trả về ids. */
  enqueue(shop: string, items: CreateVideoItem[]): number[] {
    const db = new VideoDb();
    try {
      const ids = items.map((it) => {
        const id = db.create({
          shop, productId: it.productId, listingId: it.listingId, title: it.title,
          seed: `${it.productId}:${Date.now() % 1_000_000}`,
        });
        // mainImage cache để fetchImages fallback khi detail không trả ảnh
        if (it.mainImage) {
          fs.ensureDirSync(path.join(ASSETS_DIR, it.productId));
          fs.writeFileSync(path.join(ASSETS_DIR, it.productId, "mainImage.txt"), it.mainImage, "utf-8");
        }
        return id;
      });
      this.kick();
      return ids;
    } finally { db.close(); }
  }

  retry(id: number): void {
    const db = new VideoDb();
    try {
      const row = db.get(id);
      if (!row) throw new Error(`Không có video #${id}`);
      db.setStatus(id, { status: "queued", error: null });
      this.kick();
    } finally { db.close(); }
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    setImmediate(() => this.loop().finally(() => { this.running = false; }));
  }

  private async loop(): Promise<void> {
    for (;;) {
      const db = new VideoDb();
      const next = db.list({ status: "queued", limit: 1 })[0];
      db.close();
      if (!next) return;
      try {
        await this.process(next.id);
      } catch (e: any) {
        console.error(`❌ [Video #${next.id}] ${e?.message ?? e}`);
      }
    }
  }

  private async process(id: number): Promise<void> {
    const db = new VideoDb();
    try {
      const row = db.get(id);
      if (!row || row.status !== "queued") return;
      const seed = row.seed;
      const rng = seededRng(seed);
      const account = await resolveAccountForShop(row.shop);
      if (!account) throw new Error(`Shop "${row.shop}" không có tài khoản 4Seller`);
      const principal = `acct:${account.uid}`;
      const workDir = path.join(ASSETS_DIR, row.product_id, String(id));
      await fs.ensureDir(workDir);

      let step = "images";
      try {
        // ── 1. Ảnh ──
        db.setStatus(id, { status: "generating", step });
        console.log(`🎬 [Video #${id}] ${row.title.slice(0, 50)} — bước ảnh`);
        const mainImageFile = path.join(ASSETS_DIR, row.product_id, "mainImage.txt");
        const mainImage = (await fs.pathExists(mainImageFile)) ? await fs.readFile(mainImageFile, "utf-8") : undefined;
        const { files: images } = await fetchImages({
          principal, listingId: row.listing_id, productId: row.product_id,
          videoId: id, seed, mainImage,
        });
        console.log(`   ✅ ${images.length} ảnh`);

        // ── 2. Script (tái dùng nếu đã có) ──
        step = "script";
        db.setStatus(id, { status: "generating", step });
        let script: VideoScript;
        if (row.script_json) {
          script = validateScript(JSON.parse(row.script_json));
          console.log(`   💾 Tái dùng script cũ`);
        } else {
          script = await genVideoScript(row.title);
          db.setScript(id, JSON.stringify(script));
          console.log(`   ✅ Script: "${script.hook}"`);
        }

        // ── 3. TTS (tái dùng nếu voice.mp3 + words.json đã có) ──
        step = "tts";
        db.setStatus(id, { status: "generating", step });
        const voicePath = path.join(workDir, "voice.mp3");
        const wordsPath = path.join(workDir, "words.json");
        let words, durationMs, voiceName;
        if ((await fs.pathExists(voicePath)) && (await fs.pathExists(wordsPath))) {
          ({ words, durationMs, voiceName } = await fs.readJson(wordsPath));
          console.log(`   💾 Tái dùng voice cũ (${voiceName})`);
        } else {
          voiceName = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
          const r = await edgeTtsEngine.synthesize(scriptToText(script), voiceName, voicePath);
          words = r.words; durationMs = r.durationMs;
          await fs.writeJson(wordsPath, { words, durationMs, voiceName });
          console.log(`   ✅ TTS ${voiceName}, ${Math.round(durationMs / 1000)}s`);
        }
        db.setStatus(id, { status: "generating", step, voice: voiceName });

        // ── 4. Render ──
        step = "render";
        db.setStatus(id, { status: "generating", step });
        const plan = planSegments(images.length, durationMs);
        const ordered = seededShuffle(seededRng(`order:${seed}`), images);
        const segImages = Array.from({ length: plan.n }, (_, i) => ordered[i % ordered.length]);
        const assPath = path.join(workDir, "captions.ass");
        await fs.writeFile(assPath, buildAss({
          words, hook: script.hook, cta: script.cta,
          totalMs: Math.round(plan.totalSec * 1000), seed,
        }), "utf-8");
        const music = await pickMusic(rng);
        const outPath = path.join(VIDEOS_DIR, safeName(row.shop), `${row.product_id}_${id}.mp4`);
        console.log(`   🎬 Render ${plan.n} segments, ${plan.totalSec}s${music ? ", nhạc: " + path.basename(music) : ", không nhạc"}`);
        await renderVideo({ images: segImages, plan, voicePath, musicPath: music, assPath, outPath, seed });

        db.setStatus(id, { status: "ready", file: outPath });
        console.log(`✅ [Video #${id}] READY → ${outPath}`);
      } catch (e: any) {
        db.setStatus(id, { status: "error", step, error: String(e?.message ?? e).slice(0, 500) });
        console.error(`❌ [Video #${id}] bước "${step}": ${e?.message ?? e}`);
      }
    } finally { db.close(); }
  }
}

async function pickMusic(rng: () => number): Promise<string | null> {
  try {
    const files = (await fs.readdir(MUSIC_DIR)).filter((f) => /\.mp3$/i.test(f));
    if (!files.length) return null;
    return path.join(MUSIC_DIR, seededPick(rng, files));
  } catch { return null; } // thư mục chưa tồn tại → không nhạc, không lỗi
}

export const videoQueue = new VideoQueue();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/videoStudio/videoQueue.ts
git commit -m "feat(video-studio): queue tuan tu pipeline images->script->tts->render

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Routes + UI (`routes.ts`, `videos.html`, sửa `adminServer.ts`)

**Files:**
- Create: `src/core/videoStudio/routes.ts`
- Create: `src/public/videos.html`
- Modify: `src/adminServer.ts` (2 chỗ: import + 2 dòng đăng ký, đặt cạnh route `/admin` hiện có ~dòng 137)

- [ ] **Step 1: Implement routes**

```ts
// src/core/videoStudio/routes.ts
/**
 * Routes Video Studio, mount vào admin server (đã qua requireAuth vì
 * path /admin/api/*). Tách file riêng để adminServer.ts không phình thêm.
 */
import type express from "express";
import fs from "fs-extra";
import path from "path";
import { VideoDb } from "../../state/videoDb";
import { TiktokDb } from "../../services/tiktok/db";
import { suggestProducts } from "./suggestProducts";
import { videoQueue, CreateVideoItem } from "./videoQueue";

export function registerVideoRoutes(app: express.Express): void {
  // Shops có data view để đề xuất
  app.get("/admin/api/videos/shops", (_req, res) => {
    const db = new TiktokDb();
    try { res.json({ shops: db.listTrackedShops() }); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
    finally { db.close(); }
  });

  // Đề xuất sản phẩm tiềm năng của 1 shop
  app.get("/admin/api/videos/suggest", async (req, res) => {
    try {
      const shop = String(req.query.shop ?? "");
      if (!shop) return res.status(400).json({ error: "Thiếu ?shop=" });
      const limit = Math.min(200, parseInt(String(req.query.limit ?? "50")) || 50);
      res.json(await suggestProducts(shop, { limit }));
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // Enqueue tạo video
  app.post("/admin/api/videos/create", (req, res) => {
    try {
      const { shop, items } = req.body as { shop: string; items: CreateVideoItem[] };
      if (!shop || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: "Cần {shop, items:[{productId,listingId,title}]}" });
      }
      const ids = videoQueue.enqueue(shop, items);
      res.json({ queued: ids.length, ids });
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // List videos
  app.get("/admin/api/videos", (req, res) => {
    const db = new VideoDb();
    try {
      res.json({
        videos: db.list({
          shop: req.query.shop ? String(req.query.shop) : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
        }),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
    finally { db.close(); }
  });

  // Stream/download file mp4
  app.get("/admin/api/videos/file/:id", (req, res) => {
    const db = new VideoDb();
    try {
      const row = db.get(parseInt(req.params.id));
      if (!row?.file || !fs.pathExistsSync(row.file)) return res.status(404).json({ error: "Chưa có file" });
      res.sendFile(path.resolve(row.file));
    } finally { db.close(); }
  });

  app.post("/admin/api/videos/:id/retry", (req, res) => {
    try { videoQueue.retry(parseInt(req.params.id)); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  app.post("/admin/api/videos/:id/posted", (req, res) => {
    const db = new VideoDb();
    try { db.markPosted(parseInt(req.params.id)); res.json({ ok: true }); }
    finally { db.close(); }
  });

  // Xóa row + file mp4 (giữ assets cache ảnh của sản phẩm)
  app.delete("/admin/api/videos/:id", async (req, res) => {
    const db = new VideoDb();
    try {
      const row = db.get(parseInt(req.params.id));
      if (row?.file) await fs.remove(row.file).catch(() => {});
      db.remove(parseInt(req.params.id));
      res.json({ ok: true });
    } finally { db.close(); }
  });
}
```

- [ ] **Step 2: Sửa `adminServer.ts`**

Thêm import cạnh các import hiện có đầu file:

```ts
import { registerVideoRoutes } from "./core/videoStudio/routes";
```

Thêm route trang + đăng ký API, đặt NGAY SAU block `app.get("/admin", ...)` (hiện ~dòng 137-142):

```ts
  app.get("/admin/videos", (req, res) => {
    if (req.session && (req.session as any).user) {
      return res.sendFile(path.join(__dirname, "public", "videos.html"));
    }
    return res.redirect("/admin/login");
  });
  registerVideoRoutes(app);
```

- [ ] **Step 3: Tạo `videos.html`**

Style tối giản khớp tông admin hiện có (dark, CSS variables). Polling 4s thay vì SSE (đơn giản, đủ dùng); log realtime đã có ở trang admin chính.

```html
<!-- src/public/videos.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Video Studio</title>
<style>
  :root { --bg:#0f1115; --bg-elev:#171a21; --border:#2a2f3a; --text:#e6e9ef; --text-mute:#8b93a3; --accent:#4f8cff; --ok:#2ecc71; --err:#e74c3c; --warn:#f1c40f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,Segoe UI,sans-serif; }
  header { display:flex; align-items:center; gap:16px; padding:14px 20px; border-bottom:1px solid var(--border); }
  header h1 { font-size:1.1rem; margin:0; }
  header a { color:var(--text-mute); text-decoration:none; }
  .tabs { display:flex; gap:8px; padding:12px 20px 0; }
  .tab { padding:8px 16px; border:1px solid var(--border); border-bottom:none; border-radius:10px 10px 0 0; cursor:pointer; background:var(--bg); color:var(--text-mute); }
  .tab.active { background:var(--bg-elev); color:var(--text); }
  main { padding:16px 20px; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
  select,input,button { background:var(--bg-elev); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:0.9rem; }
  button { cursor:pointer; } button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:0.5; cursor:default; }
  table { width:100%; border-collapse:collapse; background:var(--bg-elev); border-radius:12px; overflow:hidden; }
  th,td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { color:var(--text-mute); font-weight:600; font-size:0.8rem; }
  td img { width:44px; height:58px; object-fit:cover; border-radius:6px; }
  .mono { font-family:Consolas,monospace; }
  .badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:0.75rem; }
  .b-ready{background:#153f2a;color:var(--ok)} .b-error{background:#3f1515;color:var(--err)}
  .b-generating{background:#3f3a15;color:var(--warn)} .b-queued{background:#1c2333;color:var(--accent)}
  .b-posted{background:#2a1c3f;color:#b98aff}
  .reason { display:inline-block; background:#1c2333; color:var(--accent); border-radius:6px; padding:1px 7px; margin-right:4px; font-size:0.75rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:14px; }
  .card { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; padding:10px; }
  .card video { width:100%; border-radius:8px; background:#000; aspect-ratio:9/16; }
  .card .t { font-size:0.82rem; margin:8px 0 4px; height:2.5em; overflow:hidden; }
  .card .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
  .card .actions button, .card .actions a { font-size:0.75rem; padding:4px 9px; text-decoration:none; }
  .empty { color:var(--text-mute); padding:30px; text-align:center; }
  .err-detail { color:var(--err); font-size:0.75rem; margin-top:4px; word-break:break-all; }
</style>
</head>
<body>
<header>
  <h1>🎬 Video Studio</h1>
  <a href="/admin">← Admin</a>
</header>
<div class="tabs">
  <div class="tab active" data-tab="suggest">💡 Đề xuất</div>
  <div class="tab" data-tab="library">📚 Thư viện</div>
</div>
<main>
  <section id="tab-suggest">
    <div class="bar">
      <select id="shopSel"><option value="">— chọn shop —</option></select>
      <button id="btnSuggest" class="primary">Đề xuất sản phẩm</button>
      <button id="btnCreate" disabled>🎬 Tạo video cho mục đã chọn</button>
      <span id="suggestInfo" style="color:var(--text-mute)"></span>
    </div>
    <div id="suggestBody" class="empty">Chọn shop rồi bấm "Đề xuất sản phẩm".</div>
  </section>
  <section id="tab-library" style="display:none">
    <div class="bar">
      <select id="libShop"><option value="">Tất cả shop</option></select>
      <select id="libStatus">
        <option value="">Tất cả status</option>
        <option>queued</option><option>generating</option><option>ready</option><option>error</option><option>posted</option>
      </select>
    </div>
    <div id="libBody" class="empty">Đang tải…</div>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const r = await fetch(url, opts ? { headers: { "Content-Type": "application/json" }, ...opts } : undefined);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Tabs
document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#tab-suggest").style.display = t.dataset.tab === "suggest" ? "" : "none";
  $("#tab-library").style.display = t.dataset.tab === "library" ? "" : "none";
  if (t.dataset.tab === "library") loadLibrary();
});

// Shops
let currentSuggest = null;
(async () => {
  try {
    const { shops } = await api("/admin/api/videos/shops");
    for (const sel of [$("#shopSel"), $("#libShop")])
      for (const s of shops) sel.insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`);
  } catch (e) { $("#suggestInfo").textContent = "Lỗi tải shops: " + e.message; }
})();

// ── Đề xuất ──
$("#btnSuggest").onclick = async () => {
  const shop = $("#shopSel").value;
  if (!shop) return alert("Chọn shop trước");
  $("#suggestBody").innerHTML = '<div class="empty">Đang phân tích tín hiệu view/sold…</div>';
  $("#btnCreate").disabled = true;
  try {
    currentSuggest = await api(`/admin/api/videos/suggest?shop=${encodeURIComponent(shop)}`);
    const { items, latestDate, unmatched } = currentSuggest;
    $("#suggestInfo").textContent = `${items.length} sp tiềm năng · data ${latestDate ?? "?"}${unmatched ? ` · ${unmatched} sp hết active` : ""}`;
    if (!items.length) { $("#suggestBody").innerHTML = '<div class="empty">Không có sản phẩm nào đủ tín hiệu (cần chạy crawl view hằng ngày).</div>'; return; }
    $("#suggestBody").innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="chkAll"></th><th></th><th>Sản phẩm</th>
      <th>Views 28d</th><th>Đà/ngày</th><th>Đơn 28d</th><th>Tín hiệu</th><th>Video</th>
    </tr></thead><tbody>${items.map((it, i) => `<tr>
      <td><input type="checkbox" class="chk" data-i="${i}" ${it.hasVideo ? "" : "checked"}></td>
      <td>${it.thumb ? `<img src="${esc(it.thumb)}" loading="lazy">` : ""}</td>
      <td>${esc(it.title)}<div class="mono" style="color:var(--text-mute);font-size:0.72rem">${esc(it.productId)}</div></td>
      <td class="mono">${it.pv}</td><td class="mono">+${it.avgPerDay}</td><td class="mono">${it.orders}</td>
      <td>${(it.reasons || []).map((r) => `<span class="reason">${esc(r)}</span>`).join("")}</td>
      <td>${it.hasVideo ? "✅ có" : "—"}</td>
    </tr>`).join("")}</tbody></table>`;
    $("#chkAll").onchange = (e) => document.querySelectorAll(".chk").forEach((c) => { c.checked = e.target.checked; updateCreateBtn(); });
    document.querySelectorAll(".chk").forEach((c) => c.onchange = updateCreateBtn);
    updateCreateBtn();
  } catch (e) { $("#suggestBody").innerHTML = `<div class="empty">❌ ${esc(e.message)}</div>`; }
};
const updateCreateBtn = () => {
  const n = document.querySelectorAll(".chk:checked").length;
  $("#btnCreate").disabled = !n;
  $("#btnCreate").textContent = n ? `🎬 Tạo video cho ${n} sản phẩm` : "🎬 Tạo video cho mục đã chọn";
};
$("#btnCreate").onclick = async () => {
  const idx = [...document.querySelectorAll(".chk:checked")].map((c) => +c.dataset.i);
  const items = idx.map((i) => {
    const it = currentSuggest.items[i];
    return { productId: it.productId, listingId: it.listingId, title: it.title, mainImage: it.thumb };
  });
  try {
    const r = await api("/admin/api/videos/create", { method: "POST", body: JSON.stringify({ shop: $("#shopSel").value, items }) });
    alert(`Đã đưa ${r.queued} video vào hàng đợi`);
    document.querySelector('[data-tab="library"]').click();
  } catch (e) { alert("❌ " + e.message); }
};

// ── Thư viện ──
let libTimer = null;
async function loadLibrary() {
  clearTimeout(libTimer);
  try {
    const q = new URLSearchParams();
    if ($("#libShop").value) q.set("shop", $("#libShop").value);
    if ($("#libStatus").value) q.set("status", $("#libStatus").value);
    const { videos } = await api("/admin/api/videos?" + q);
    if (!videos.length) { $("#libBody").innerHTML = '<div class="empty">Chưa có video nào.</div>'; }
    else {
      $("#libBody").innerHTML = `<div class="grid">${videos.map((v) => `<div class="card">
        ${v.status === "ready" || v.status === "posted"
          ? `<video src="/admin/api/videos/file/${v.id}" controls preload="metadata"></video>`
          : `<div style="aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;background:#000;border-radius:8px;color:var(--text-mute)">${v.status === "generating" ? "⏳ " + esc(v.step ?? "") : esc(v.status)}</div>`}
        <div class="t">${esc(v.title)}</div>
        <span class="badge b-${esc(v.status)}">${esc(v.status)}${v.status === "generating" && v.step ? " · " + esc(v.step) : ""}</span>
        <span style="color:var(--text-mute);font-size:0.72rem"> #${v.id} · ${esc(v.shop)}</span>
        ${v.error ? `<div class="err-detail">${esc(v.error)}</div>` : ""}
        <div class="actions">
          ${v.status === "ready" || v.status === "posted" ? `<a href="/admin/api/videos/file/${v.id}" download="video_${v.id}.mp4"><button>⬇ Tải</button></a>` : ""}
          ${v.status === "ready" ? `<button onclick="markPosted(${v.id})">✅ Đã đăng</button>` : ""}
          ${v.status === "error" ? `<button onclick="retryVid(${v.id})">🔄 Retry</button>` : ""}
          <button onclick="delVid(${v.id})">🗑</button>
        </div>
      </div>`).join("")}</div>`;
    }
    // đang có job chạy → poll tiếp
    if (videos.some((v) => v.status === "queued" || v.status === "generating")) libTimer = setTimeout(loadLibrary, 4000);
  } catch (e) { $("#libBody").innerHTML = `<div class="empty">❌ ${esc(e.message)}</div>`; }
}
$("#libShop").onchange = loadLibrary;
$("#libStatus").onchange = loadLibrary;
window.markPosted = async (id) => { await api(`/admin/api/videos/${id}/posted`, { method: "POST", body: "{}" }); loadLibrary(); };
window.retryVid = async (id) => { await api(`/admin/api/videos/${id}/retry`, { method: "POST", body: "{}" }); loadLibrary(); };
window.delVid = async (id) => { if (confirm("Xóa video #" + id + "?")) { await api(`/admin/api/videos/${id}`, { method: "DELETE" }); loadLibrary(); } };
</script>
</body>
</html>
```

- [ ] **Step 4: Typecheck + toàn bộ test**

Run: `npm run typecheck && npx vitest run`
Expected: cả 2 PASS (bao gồm mọi test cũ của project — không phá gì).

- [ ] **Step 5: Verify end-to-end bằng tay**

1. `npm run dev` (server admin chạy như bình thường).
2. Mở `http://localhost:<port>/admin/videos` (port như admin hiện có) → login → thấy trang Video Studio.
3. Tab Đề xuất: chọn 1 shop có data view → bấm Đề xuất → thấy bảng sp kèm reasons.
4. Tick 1 sản phẩm → Tạo video → tab Thư viện thấy status chạy `images → script → tts → render` → `ready` → preview video ngay trong trang, bấm Tải.
5. Nếu lỗi ở step nào → card hiện message đỏ + nút Retry.

- [ ] **Step 6: Commit**

```bash
git add src/core/videoStudio/routes.ts src/public/videos.html src/adminServer.ts
git commit -m "feat(video-studio): routes /admin/api/videos + UI de xuat & thu vien

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Hoàn tất — docs ngắn + kiểm tra cuối

**Files:**
- Modify: `docs/ARCHITECTURE.md` (thêm mục Video Studio — 5-8 dòng mô tả module + đường dẫn file, theo văn phong file hiện có)

- [ ] **Step 1: Thêm mục Video Studio vào `docs/ARCHITECTURE.md`** — mô tả: mục đích, luồng 6 bước như spec §3, vị trí data (`data/videos.db`, `data/videos/<shop>/*.mp4`, `data/videos/music/`), trang `/admin/videos`.

- [ ] **Step 2: Chạy toàn bộ verify lần cuối**

Run: `npm run typecheck && npx vitest run`
Expected: PASS toàn bộ.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: them muc Video Studio vao ARCHITECTURE

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review (đã chạy khi viết plan)

- **Spec coverage:** §4.1→Task 10, §4.2→Task 9, §4.3→Task 5, §4.4→Tasks 3+4, §4.5→Task 6, §4.6→Tasks 7+8, §4.7→Task 2, §4.8→Task 11, §4.9→Task 12, §5 (nhạc/font/principal)→Tasks 11+12, §6 error handling→Tasks 4/8/9/11, §7 testing→mỗi task + Task 8 smoke. Đủ.
- **Type consistency:** `TtsWord`/`TtsResult` (Task 3/4) dùng xuyên suốt; `VideoScript`+`scriptToText`+`validateScript` (Task 5) dùng ở Task 8/11; `SegmentPlan`+`buildFfmpegArgs`+`FfmpegArgsOpts` (Task 7) dùng ở Task 8/11; `VideoDb` API (Task 2) khớp cách gọi ở Task 11/12; `CreateVideoItem` (Task 11) khớp routes/UI (Task 12).
- **Điểm rủi ro có hướng xử lý trong plan:** API msedge-tts khác version (Task 4 Step 3 + Task 8 Step 4), field `title` của ListingRecord (Task 10 Step 4), filtergraph/font lỗi (Task 8 Step 3).
