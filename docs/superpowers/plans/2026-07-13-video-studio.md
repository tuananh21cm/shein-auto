# Video Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Module Video Studio trong shein-auto: Ä‘á» xuáº¥t sáº£n pháº©m tiá»m nÄƒng tá»« `listing_views` â†’ kÃ©o áº£nh tá»« 4Seller â†’ gen video TikTok 9:16 (voiceover Edge TTS + caption sync + nháº¡c ná»n, Ken Burns báº±ng FFmpeg) â†’ quáº£n lÃ½ qua admin UI.

**Architecture:** Pipeline tuáº§n tá»± per-video (fetchImages â†’ genScript â†’ tts â†’ buildAss â†’ render) cháº¡y trong in-process queue, state lÆ°u SQLite `data/videos.db`, progress qua console.log (Ä‘Ã£ tap vÃ o eventBus â†’ SSE). Render báº±ng FFmpeg cÃ³ sáºµn trÃªn mÃ¡y (zoompan + xfade + ass). Spec: `docs/superpowers/specs/2026-07-13-video-studio-design.md`.

**Tech Stack:** TypeScript + tsx, better-sqlite3, sharp, axios, ffmpeg/ffprobe (Ä‘Ã£ cÃ i trÃªn mÃ¡y, cÃ³ trong PATH), Gemini (`@google/generative-ai` Ä‘Ã£ cÃ³), dependency npm má»›i duy nháº¥t: `msedge-tts`. Test: vitest (colocated `*.test.ts` nhÆ° codebase hiá»‡n táº¡i).

**Quy Æ°á»›c chung:**
- Má»i lá»‡nh cháº¡y tá»« `C:\code\code\shein-auto`.
- Comment code báº±ng tiáº¿ng Viá»‡t, style ngáº¯n gá»n nhÆ° codebase hiá»‡n cÃ³.
- Commit sau má»—i task, message tiáº¿ng Viá»‡t khÃ´ng dáº¥u, káº¿t thÃºc báº±ng `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File map (toÃ n bá»™ file táº¡o/sá»­a)

| File | Loáº¡i | TrÃ¡ch nhiá»‡m |
|---|---|---|
| `src/core/videoStudio/rand.ts` | Create | PRNG seeded dÃ¹ng chung (mulberry32) + helpers pick/shuffle |
| `src/state/videoDb.ts` | Create | SQLite store báº£ng `videos` (data/videos.db) |
| `src/services/tts/edgeTts.ts` | Create | Edge TTS â†’ mp3 + word timestamps (+ fallback Æ°á»›c lÆ°á»£ng) |
| `src/services/tts/estimateWords.ts` | Create | Æ¯á»›c lÆ°á»£ng word timings khi TTS khÃ´ng tráº£ metadata (pure) |
| `src/utils/ffprobe.ts` | Create | Äá»c duration file audio/video báº±ng ffprobe |
| `src/services/gemini/genVideoScript.ts` | Create | Gemini gen `{hook, lines[], cta}` + validate (pure export riÃªng) |
| `src/core/videoStudio/buildAss.ts` | Create | Word timestamps â†’ file .ass (caption + hook + CTA), style theo seed |
| `src/core/videoStudio/renderPlan.ts` | Create | Pure: chia segment, build ffmpeg args (zoompan/xfade/ass/audio) |
| `src/core/videoStudio/renderVideo.ts` | Create | Spawn ffmpeg, timeout, stderr capture |
| `src/core/videoStudio/fetchImages.ts` | Create | KÃ©o áº£nh listing 4Seller â†’ sharp 1080x1920 â†’ remakeImage |
| `src/core/videoStudio/suggestProducts.ts` | Create | Join candidates `listing_views` vá»›i listing 4Seller active |
| `src/core/videoStudio/videoQueue.ts` | Create | Queue tuáº§n tá»± cháº¡y pipeline, resume tá»« step fail |
| `src/core/videoStudio/routes.ts` | Create | Express routes `/admin/api/videos/*` |
| `src/public/videos.html` | Create | UI 2 tab: Äá» xuáº¥t + ThÆ° viá»‡n |
| `src/scripts/testVideoRender.ts` | Create | Smoke test render offline (áº£nh máº«u + script hardcode) |
| `src/services/tiktok/db.ts` | Modify | ThÃªm method `listTrackedShops()` (additive) |
| `src/adminServer.ts` | Modify | Route `/admin/videos` (sendFile) + gá»i `registerVideoRoutes(app)` |
| `package.json` | Modify | ThÃªm dep `msedge-tts` (qua npm install) |

Test files (colocated): `rand.test.ts`, `videoDb.test.ts`, `estimateWords.test.ts`, `genVideoScript.test.ts`, `buildAss.test.ts`, `renderPlan.test.ts`, `fetchImages.test.ts`, `suggestProducts.test.ts`.

---

### Task 1: PRNG seeded dÃ¹ng chung (`rand.ts`)

**Files:**
- Create: `src/core/videoStudio/rand.ts`
- Test: `src/core/videoStudio/rand.test.ts`

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/core/videoStudio/rand.test.ts
import { describe, it, expect } from "vitest";
import { seededRng, seededPick, seededShuffle } from "./rand";

describe("seededRng", () => {
  it("cÃ¹ng seed â†’ cÃ¹ng chuá»—i sá»‘, khÃ¡c seed â†’ khÃ¡c", () => {
    const a1 = seededRng("abc"), a2 = seededRng("abc"), b = seededRng("xyz");
    const s1 = [a1(), a1(), a1()], s2 = [a2(), a2(), a2()], s3 = [b(), b(), b()];
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    for (const v of s1) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("seededPick / seededShuffle", () => {
  it("pick tráº£ pháº§n tá»­ thuá»™c máº£ng, shuffle giá»¯ nguyÃªn pháº§n tá»­", () => {
    const rng = seededRng("s1");
    const arr = ["a", "b", "c", "d"];
    expect(arr).toContain(seededPick(rng, arr));
    const sh = seededShuffle(seededRng("s2"), arr);
    expect(sh).not.toBe(arr);           // khÃ´ng mutate máº£ng gá»‘c
    expect([...sh].sort()).toEqual([...arr].sort());
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/core/videoStudio/rand.test.ts`
Expected: FAIL â€” "Cannot find module './rand'"

- [x] **Step 3: Implement**

```ts
// src/core/videoStudio/rand.ts
/**
 * PRNG xÃ¡c Ä‘á»‹nh theo seed (xfnv1a hash + mulberry32) â€” dÃ¹ng random hÃ³a
 * Má»ŒI lá»±a chá»n cá»§a 1 video (giá»ng, nháº¡c, style caption, zoom/pan, transition)
 * Ä‘á»ƒ re-run cÃ¹ng seed ra cÃ¹ng káº¿t quáº£, khÃ¡c seed ra video khÃ¡c nhau (chá»‘ng trÃ¹ng).
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

/** Fisherâ€“Yates, KHÃ”NG mutate máº£ng gá»‘c. */
export function seededShuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/core/videoStudio/rand.test.ts`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

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

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/state/videoDb.test.ts
import { describe, it, expect } from "vitest";
import { VideoDb } from "./videoDb";

const mk = () => new VideoDb(":memory:");

describe("VideoDb", () => {
  it("create â†’ get â†’ status flow queuedâ†’generatingâ†’ready", () => {
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

  it("error lÆ°u step + message, retry Ä‘Æ°a vá» queued giá»¯ nguyÃªn script", () => {
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
    expect(db.hasReadyVideo("PA")).toBe(true); // posted váº«n tÃ­nh lÃ  Ä‘Ã£ cÃ³ video
    db.remove(b);
    expect(db.get(b)).toBeUndefined();
    db.close();
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/state/videoDb.test.ts`
Expected: FAIL â€” "Cannot find module './videoDb'"

- [x] **Step 3: Implement**

```ts
// src/state/videoDb.ts
/**
 * videoDb â€” state cá»§a Video Studio: má»—i row = 1 video cá»§a 1 sáº£n pháº©m.
 * Status flow: queued â†’ generating â†’ ready | error ; ready â†’ posted (user Ä‘Ã¡nh dáº¥u).
 * 1 sáº£n pháº©m cÃ³ thá»ƒ nhiá»u video (regen = row má»›i, seed má»›i).
 * DB riÃªng data/videos.db (khÃ´ng Ä‘á»¥ng data/tiktok.db cá»§a crawler).
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
  step: string | null;        // step hiá»‡n táº¡i/step fail: images|script|tts|render
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

  /** Update status + cÃ¡c field kÃ¨m theo. error: null = xÃ³a error cÅ© (retry). */
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

  /** Sáº£n pháº©m Ä‘Ã£ cÃ³ video hoÃ n chá»‰nh chÆ°a (ready hoáº·c posted). */
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

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/state/videoDb.test.ts`
Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add src/state/videoDb.ts src/state/videoDb.test.ts
git commit -m "feat(video-studio): SQLite store videos.db (status flow, retry, posted)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: TTS â€” Æ°á»›c lÆ°á»£ng word timings (pure) + ffprobe helper

**Files:**
- Create: `src/services/tts/estimateWords.ts`
- Create: `src/utils/ffprobe.ts`
- Test: `src/services/tts/estimateWords.test.ts`

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/services/tts/estimateWords.test.ts
import { describe, it, expect } from "vitest";
import { estimateWordTimings } from "./estimateWords";

describe("estimateWordTimings", () => {
  it("chia duration theo trá»ng sá»‘ Ä‘á»™ dÃ i tá»«, phá»§ kÃ­n 0â†’duration, khÃ´ng chá»“ng láº¥n", () => {
    const words = estimateWordTimings("Hi this is a wonderful dress", 6000);
    expect(words.map((w) => w.text)).toEqual(["Hi", "this", "is", "a", "wonderful", "dress"]);
    expect(words[0].startMs).toBe(0);
    expect(words[words.length - 1].endMs).toBe(6000);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBe(words[i - 1].endMs);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
    }
    // tá»« dÃ i hÆ¡n Ä‘Æ°á»£c nhiá»u thá»i gian hÆ¡n tá»« 1 kÃ½ tá»±
    const wonderful = words[4], a = words[3];
    expect(wonderful.endMs - wonderful.startMs).toBeGreaterThan(a.endMs - a.startMs);
  });

  it("text rá»—ng â†’ máº£ng rá»—ng", () => {
    expect(estimateWordTimings("   ", 3000)).toEqual([]);
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/services/tts/estimateWords.test.ts`
Expected: FAIL â€” "Cannot find module './estimateWords'"

- [x] **Step 3: Implement estimateWords + ffprobe**

```ts
// src/services/tts/estimateWords.ts
/**
 * Fallback khi Edge TTS khÃ´ng tráº£ WordBoundary metadata: Æ°á»›c lÆ°á»£ng timestamp
 * tá»«ng tá»« báº±ng cÃ¡ch chia duration audio theo trá»ng sá»‘ (sá»‘ kÃ½ tá»± + 1).
 * Äá»§ tá»‘t cho caption TikTok (lá»‡ch < ~200ms); cÃ³ metadata tháº­t thÃ¬ khÃ´ng dÃ¹ng.
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
 * Äá»c duration (ms) cá»§a file audio/video báº±ng ffprobe (Ä‘Ã£ cÃ³ trong PATH,
 * cÃ¹ng bá»™ vá»›i ffmpeg gyan.dev full-build trÃªn mÃ¡y).
 */
import { execFile } from "child_process";

export function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe lá»—i (${file}): ${err.message}`));
        const sec = parseFloat(String(stdout).trim());
        if (!isFinite(sec) || sec <= 0) return reject(new Error(`ffprobe khÃ´ng Ä‘á»c Ä‘Æ°á»£c duration: "${stdout}"`));
        resolve(Math.round(sec * 1000));
      }
    );
  });
}
```

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/services/tts/estimateWords.test.ts`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

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

KhÃ´ng unit-test pháº§n gá»i network (service free bÃªn ngoÃ i); pháº§n pure (estimate) Ä‘Ã£ test á»Ÿ Task 3. Verify báº±ng smoke script á»Ÿ Task 8.

- [x] **Step 1: CÃ i dependency**

Run: `npm install msedge-tts`
Expected: thÃªm vÃ o `package.json` dependencies, khÃ´ng lá»—i peer-dep.

- [x] **Step 2: Implement**

```ts
// src/services/tts/edgeTts.ts
/**
 * Edge TTS (free, khÃ´ng cáº§n API key) qua package msedge-tts.
 * Tráº£ mp3 + word timestamps tá»« WordBoundary metadata; version package khÃ´ng
 * tráº£ metadata â†’ fallback estimateWordTimings (Task 3).
 *
 * Bá»c sau interface TtsEngine Ä‘á»ƒ sau nÃ y swap OpenAI TTS chá»‰ sá»­a file nÃ y.
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

/** Pool giá»ng en-US neural â€” random theo seed video á»Ÿ videoQueue. */
export const VOICE_POOL = [
  "en-US-JennyNeural",
  "en-US-AriaNeural",
  "en-US-MichelleNeural",
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
];

/** Parse metadata chunk cá»§a Edge (JSON cÃ³ máº£ng Metadata[].Type="WordBoundary"). Offset/Duration tÃ­nh báº±ng tick 100ns. */
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
    } catch { /* chunk khÃ´ng pháº£i JSON hoÃ n chá»‰nh â†’ bá» */ }
  }
  return words;
}

async function synthesizeOnce(text: string, voice: string, outFile: string): Promise<TtsResult> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // toStream: version má»›i tráº£ {audioStream, metadataStream}, cÅ© tráº£ Readable.
  const res: any = await tts.toStream(text);
  const audioStream = res?.audioStream ?? res;
  const metadataStream = res?.metadataStream ?? null;

  const metaChunks: string[] = [];
  if (metadataStream) {
    metadataStream.on("data", (c: any) => metaChunks.push(String(c)));
    metadataStream.on("error", () => { /* metadata lá»—i khÃ´ng cháº·n audio */ });
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
  if (audio.length < 1000) throw new Error(`Edge TTS tráº£ audio quÃ¡ ngáº¯n (${audio.length} bytes)`);
  await fs.ensureDir(path.dirname(outFile));
  await fs.writeFile(outFile, audio);

  const durationMs = await probeDurationMs(outFile);
  let words = parseWordBoundaries(metaChunks);
  // metadata thiáº¿u/lá»‡ch quÃ¡ nhiá»u so vá»›i sá»‘ tá»« tháº­t â†’ dÃ¹ng Æ°á»›c lÆ°á»£ng
  const nTokens = text.split(/\s+/).filter(Boolean).length;
  if (words.length < nTokens * 0.7) {
    console.warn(`âš ï¸ [TTS] WordBoundary chá»‰ cÃ³ ${words.length}/${nTokens} tá»« â†’ dÃ¹ng Æ°á»›c lÆ°á»£ng.`);
    words = estimateWordTimings(text, durationMs);
  }
  return { file: outFile, words, durationMs };
}

export const edgeTtsEngine: TtsEngine = {
  /** Retry 3 láº§n (service free cháº­p chá»n), backoff 2s/4s. */
  async synthesize(text, voice, outFile) {
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await synthesizeOnce(text, voice, outFile);
      } catch (e: any) {
        lastErr = e;
        console.warn(`âš ï¸ [TTS] Láº§n ${attempt}/3 lá»—i: ${e?.message ?? e}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    throw new Error(`Edge TTS tháº¥t báº¡i sau 3 láº§n: ${lastErr?.message ?? lastErr}`);
  },
};
```

- [x] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Náº¿u lá»—i type do API msedge-tts khÃ¡c version (vd `setMetadata` cáº§n 3 args, `close` khÃ´ng tá»“n táº¡i): má»Ÿ `node_modules/msedge-tts/dist/*.d.ts` Ä‘á»c signature tháº­t vÃ  chá»‰nh cho khá»›p â€” GIá»® nguyÃªn hÃ nh vi defensive (audioStream ?? res, metadataStream ?? null).

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json src/services/tts/edgeTts.ts
git commit -m "feat(video-studio): Edge TTS engine (mp3 + word timestamps, retry 3 lan)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Gemini gen script (`genVideoScript.ts`)

**Files:**
- Create: `src/services/gemini/genVideoScript.ts`
- Test: `src/services/gemini/genVideoScript.test.ts` (chá»‰ test hÃ m validate pure â€” khÃ´ng gá»i API tháº­t)

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/services/gemini/genVideoScript.test.ts
import { describe, it, expect } from "vitest";
import { validateScript, scriptToText } from "./genVideoScript";

describe("validateScript", () => {
  it("cháº¥p nháº­n script há»£p lá»‡, trim khoáº£ng tráº¯ng", () => {
    const s = validateScript({ hook: " Stop scrolling! ", lines: ["Line one.", "Line two."], cta: "Get yours now" });
    expect(s.hook).toBe("Stop scrolling!");
    expect(s.lines).toEqual(["Line one.", "Line two."]);
  });

  it("cáº¯t bá»›t khi tá»•ng > 110 tá»« (giá»¯ hook + cta, bá» lines cuá»‘i)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `sentence number ${i} has exactly six words`);
    const s = validateScript({ hook: "Hook here", lines: long, cta: "Buy now" });
    const totalWords = scriptToText(s).split(/\s+/).length;
    expect(totalWords).toBeLessThanOrEqual(110);
    expect(s.cta).toBe("Buy now");
  });

  it("throw khi thiáº¿u hook hoáº·c lines rá»—ng", () => {
    expect(() => validateScript({ hook: "", lines: ["x"], cta: "y" })).toThrow();
    expect(() => validateScript({ hook: "h", lines: [], cta: "y" })).toThrow();
  });
});

describe("scriptToText", () => {
  it("ná»‘i hook + lines + cta thÃ nh 1 Ä‘oáº¡n cho TTS", () => {
    expect(scriptToText({ hook: "A.", lines: ["B.", "C."], cta: "D." })).toBe("A. B. C. D.");
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/services/gemini/genVideoScript.test.ts`
Expected: FAIL â€” "Cannot find module './genVideoScript'"

- [x] **Step 3: Implement**

```ts
// src/services/gemini/genVideoScript.ts
/**
 * Gen script video TikTok (EN) tá»« title sáº£n pháº©m: {hook, lines[], cta}.
 * Tá»•ng ~70-100 tá»« â‰ˆ 25-35s voiceover. Model + retry pattern giá»‘ng genTitleFromShein.
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

/** Validate + chuáº©n hÃ³a output LLM. Throw náº¿u thiáº¿u trÆ°á»ng báº¯t buá»™c. */
export function validateScript(raw: any): VideoScript {
  const hook = String(raw?.hook ?? "").trim();
  const cta = String(raw?.cta ?? "").trim();
  let lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l: any) => String(l).trim()).filter(Boolean);
  if (!hook) throw new Error("Script thiáº¿u hook");
  if (!lines.length) throw new Error("Script thiáº¿u lines");
  if (!cta) throw new Error("Script thiáº¿u cta");
  // Cap tá»•ng ~110 tá»«: bá» dáº§n lines cuá»‘i (giá»¯ hook + cta) Ä‘á»ƒ voiceover khÃ´ng quÃ¡ 40s.
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let total = wc(hook) + wc(cta) + lines.reduce((a: number, l: string) => a + wc(l), 0);
  while (total > 110 && lines.length > 1) {
    total -= wc(lines[lines.length - 1]);
    lines = lines.slice(0, -1);
  }
  return { hook, lines, cta };
}

/** Text Ä‘áº§y Ä‘á»§ Ä‘Æ°a vÃ o TTS. */
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

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/services/gemini/genVideoScript.test.ts`
Expected: PASS (4 tests)

- [x] **Step 5: Commit**

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

- [x] **Step 1: Viáº¿t test fail**

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
  it("nhÃ³m 2-4 tá»«, thá»i gian ná»‘i tiáº¿p khÃ´ng chá»“ng láº¥n", () => {
    const lines = groupWords(words, "seed1");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      const n = l.text.split(" ").length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
      expect(l.endMs).toBeGreaterThan(l.startMs);
    }
    for (let i = 1; i < lines.length; i++) expect(lines[i].startMs).toBeGreaterThanOrEqual(lines[i - 1].endMs);
    // ghÃ©p láº¡i Ä‘á»§ má»i tá»«
    expect(lines.map((l) => l.text).join(" ")).toBe(words.map((w) => w.text).join(" "));
  });

  it("cÃ¹ng seed cho cÃ¹ng káº¿t quáº£", () => {
    expect(groupWords(words, "s")).toEqual(groupWords(words, "s"));
  });
});

describe("buildAss", () => {
  it("sinh file ASS há»£p lá»‡: header, style, hook Ä‘áº§u, cta cuá»‘i, caption theo timestamps", () => {
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
    // caption Ä‘áº§u tiÃªn báº¯t Ä‘áº§u 0:00:00.00
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,.*Caption/);
    // CTA náº±m trong 3s cuá»‘i
    expect(ass).toContain(`,${msToAssTime(10000)},`);
  });

  it("escape kÃ½ tá»± Ä‘áº·c biá»‡t ASS trong text ({, }, \\n)", () => {
    const ass = buildAss({
      words: [{ text: "50%", startMs: 0, endMs: 500 }],
      hook: "Deal {today}", cta: "Now\\here", totalMs: 3000, seed: "x",
    });
    expect(ass).not.toContain("{today}");   // { } pháº£i bá»‹ escape/loáº¡i
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/core/videoStudio/buildAss.test.ts`
Expected: FAIL â€” "Cannot find module './buildAss'"

- [x] **Step 3: Implement**

```ts
// src/core/videoStudio/buildAss.ts
/**
 * Build file .ass: caption sync theo word timestamps (nhÃ³m 2-4 tá»«/dÃ²ng),
 * hook overlay ~2s Ä‘áº§u, CTA 2.5s cuá»‘i. Style chá»n theo seed tá»« 5 preset
 * (font/mÃ u/viá»n) â€” font há»‡ thá»‘ng Windows, khÃ´ng bundle.
 * DÃ¹ng .ass thay drawtext Ä‘á»ƒ khá»i escape text trong filtergraph ffmpeg.
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

/** {} lÃ  control code cá»§a ASS, \ báº¯t Ä‘áº§u override â†’ thay báº±ng kÃ½ tá»± an toÃ n. */
const escapeAss = (s: string): string =>
  s.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, " ");

/** NhÃ³m 2-4 tá»« thÃ nh 1 dÃ²ng caption (kÃ­ch thÆ°á»›c nhÃ³m random theo seed). */
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
  // kÃ©o endMs cá»§a dÃ²ng tá»›i startMs dÃ²ng sau (Ä‘á»¡ nhÃ¡y giá»¯a cÃ¡c dÃ²ng), khÃ´ng chá»“ng láº¥n
  for (let k = 0; k < lines.length - 1; k++) lines[k].endMs = Math.max(lines[k].endMs, lines[k + 1].startMs);
  return lines;
}

interface StylePreset { name: string; caption: string; hook: string }

/** PrimaryColour ASS = &HAABBGGRR (AA=00 Ä‘á»¥c). 5 preset Ä‘á»•i font/mÃ u chá»‘ng trÃ¹ng template. */
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
  // Hook overlay 0 â†’ min(2200ms, 1/4 video)
  const hookEnd = Math.min(2200, Math.round(opts.totalMs / 4));
  events.push(`Dialogue: 0,${msToAssTime(0)},${msToAssTime(hookEnd)},Hook,,0,0,0,,${escapeAss(opts.hook.toUpperCase())}`);
  // Caption theo timestamps
  for (const l of lines) {
    events.push(`Dialogue: 0,${msToAssTime(l.startMs)},${msToAssTime(l.endMs)},Caption,,0,0,0,,${escapeAss(l.text)}`);
  }
  // CTA 2.5s cuá»‘i
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

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/core/videoStudio/buildAss.test.ts`
Expected: PASS (5 tests)

- [x] **Step 5: Commit**

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

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/core/videoStudio/renderPlan.test.ts
import { describe, it, expect } from "vitest";
import { planSegments, buildFfmpegArgs, escapeFilterPath } from "./renderPlan";

describe("planSegments", () => {
  it("tá»•ng duration trá»« overlap xfade = voice + 0.8s tail", () => {
    const p = planSegments(6, 30000); // 6 áº£nh, voice 30s
    const total = 30.8;
    const sum = p.durations.reduce((a, b) => a + b, 0);
    expect(sum - p.fade * (p.n - 1)).toBeCloseTo(total, 1);
    expect(p.n).toBe(p.durations.length);
    for (const d of p.durations) { expect(d).toBeGreaterThanOrEqual(2.0); expect(d).toBeLessThanOrEqual(6.5); }
  });

  it("voice ngáº¯n (12s) â†’ Ã­t segment; dÃ i (40s) â†’ nhiá»u segment", () => {
    expect(planSegments(8, 12000).n).toBeLessThan(planSegments(8, 40000).n);
  });

  it("Ã­t áº£nh hÆ¡n segment â†’ khÃ´ng sao (queue sáº½ láº·p áº£nh); n >= 2 luÃ´n", () => {
    const p = planSegments(3, 35000);
    expect(p.n).toBeGreaterThanOrEqual(2);
  });
});

describe("escapeFilterPath", () => {
  it("Ä‘á»•i backslash â†’ slash, escape dáº¥u hai cháº¥m cho ffmpeg filter", () => {
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

  it("Ä‘á»§ input áº£nh + voice, filter cÃ³ zoompan/xfade/ass, map vout/aout, -t Ä‘Ãºng total", () => {
    const args = buildFfmpegArgs({ ...base, musicPath: null });
    const s = args.join(" ");
    expect(args.filter((a) => a === "-i").length).toBe(plan.n + 1); // n áº£nh + voice
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

  it("cÃ³ nháº¡c â†’ thÃªm input stream_loop + amix; khÃ´ng nháº¡c â†’ chá»‰ apad voice", () => {
    const withMusic = buildFfmpegArgs({ ...base, musicPath: "C:\\m\\bg.mp3" });
    expect(withMusic.join(" ")).toContain("-stream_loop -1");
    expect(withMusic[withMusic.indexOf("-filter_complex") + 1]).toContain("amix");
    const noMusic = buildFfmpegArgs({ ...base, musicPath: null });
    expect(noMusic[noMusic.indexOf("-filter_complex") + 1]).not.toContain("amix");
  });

  it("cÃ¹ng seed â†’ args giá»‘ng há»‡t (deterministic)", () => {
    expect(buildFfmpegArgs({ ...base, musicPath: null })).toEqual(buildFfmpegArgs({ ...base, musicPath: null }));
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/core/videoStudio/renderPlan.test.ts`
Expected: FAIL â€” "Cannot find module './renderPlan'"

- [x] **Step 3: Implement**

```ts
// src/core/videoStudio/renderPlan.ts
/**
 * Pure logic render: chia video thÃ nh N segment áº£nh (Ken Burns) ná»‘i báº±ng xfade,
 * vÃ  build args ffmpeg hoÃ n chá»‰nh. TÃ¡ch pure Ä‘á»ƒ unit-test khÃ´ng cáº§n cháº¡y ffmpeg.
 *
 * Cáº¥u trÃºc filtergraph:
 *   má»—i áº£nh: scale 2x â†’ zoompan (chá»‘ng jitter) â†’ 1080x1920@30fps
 *   ná»‘i: xfade dÃ¢y chuyá»n, offset_m = sum(d_0..d_{m-1}) âˆ’ mÂ·fade
 *   cuá»‘i: ass=caption, format=yuv420p
 *   audio: voice apad tá»›i total (+ nháº¡c ná»n loop, volume 0.18, amix)
 */
import { seededRng, seededPick } from "./rand";

export interface SegmentPlan {
  n: number;            // sá»‘ segment
  durations: number[];  // giÃ¢y, gross (Ä‘Ã£ gá»“m pháº§n overlap fade)
  fade: number;         // giÃ¢y
  totalSec: number;     // duration video cuá»‘i
}

const FADE = 0.4;
const TARGET_SEG = 3.5;   // giÃ¢y/áº£nh lÃ½ tÆ°á»Ÿng
const MIN_SEG = 2.0;
const MAX_SEG = 6.5;

export function planSegments(imageCount: number, voiceMs: number): SegmentPlan {
  const totalSec = voiceMs / 1000 + 0.8; // tail 0.8s sau khi voice háº¿t
  let n = Math.max(2, Math.round(totalSec / TARGET_SEG));
  // gross má»—i segment = (total + fade*(n-1)) / n â€” chá»‰nh n Ä‘á»ƒ náº±m trong [MIN,MAX]
  const gross = (k: number) => (totalSec + FADE * (k - 1)) / k;
  while (n > 2 && gross(n) < MIN_SEG) n--;
  while (gross(n) > MAX_SEG) n++;
  const d = gross(n);
  return { n, durations: Array.from({ length: n }, () => Math.round(d * 100) / 100), fade: FADE, totalSec: Math.round(totalSec * 100) / 100 };
}

/** Path Windows â†’ dáº¡ng ffmpeg filter cháº¥p nháº­n: slash + escape ':'. */
export const escapeFilterPath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/:/g, "\\:");

const XFADE_TRANSITIONS = ["fade", "slideleft", "slideright", "slideup", "smoothleft", "smoothright"];

/** 4 biáº¿n thá»ƒ Ken Burns; chá»n theo seed tá»«ng segment. */
const KENBURNS = [
  // zoom in giá»¯a
  (f: number) => `z='min(1+0.12*on/${f},1.12)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom out giá»¯a
  (f: number) => `z='max(1.12-0.12*on/${f},1.001)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trÃ¡iâ†’pháº£i
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)*on/${f}':y='(ih-ih/zoom)/2'`,
  // zoom in + pan trÃªnâ†’dÆ°á»›i
  (f: number) => `z='min(1+0.10*on/${f},1.10)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*on/${f}'`,
];

export interface FfmpegArgsOpts {
  images: string[];          // Ä‘Ãºng plan.n pháº§n tá»­ (queue Ä‘Ã£ láº·p/cáº¯t sáºµn)
  plan: SegmentPlan;
  voicePath: string;
  musicPath: string | null;
  assPath: string;
  outPath: string;
  seed: string;
}

export function buildFfmpegArgs(o: FfmpegArgsOpts): string[] {
  const { plan } = o;
  if (o.images.length !== plan.n) throw new Error(`images (${o.images.length}) pháº£i = plan.n (${plan.n})`);
  const rng = seededRng(`render:${o.seed}`);
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

  // Inputs: n áº£nh loop
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
  // xfade chain: offset_m = sum(d_0..d_{m-1}) âˆ’ mÂ·fade
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

- [x] **Step 4: Cháº¡y test â€” pháº£i PASS**

Run: `npx vitest run src/core/videoStudio/renderPlan.test.ts`
Expected: PASS (7 tests)

- [x] **Step 5: Commit**

```bash
git add src/core/videoStudio/renderPlan.ts src/core/videoStudio/renderPlan.test.ts
git commit -m "feat(video-studio): segment plan + ffmpeg args builder (zoompan/xfade/ass)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: FFmpeg runner + smoke test render tháº­t

**Files:**
- Create: `src/core/videoStudio/renderVideo.ts`
- Create: `src/scripts/testVideoRender.ts`

- [x] **Step 1: Implement runner**

```ts
// src/core/videoStudio/renderVideo.ts
/**
 * Spawn ffmpeg render 1 video. Timeout 120s (spec Â§6), capture stderr tail
 * lÃ m message lá»—i. ffmpeg Ä‘Ã£ cÃ³ trong PATH (gyan.dev full-build).
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
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`KhÃ´ng cháº¡y Ä‘Æ°á»£c ffmpeg: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-600)}`));
    });
  });
  if (!(await fs.pathExists(opts.outPath))) throw new Error("FFmpeg xong nhÆ°ng khÃ´ng tháº¥y file output");
  return opts.outPath;
}
```

- [x] **Step 2: Viáº¿t smoke script**

áº¢nh máº«u cÃ³ sáºµn trong repo: `src/core/steps/temp_images_a6e6dd02e280840e/img_0.jpg`, `img_1.jpg`, `img_2.jpg`.

```ts
// src/scripts/testVideoRender.ts
/**
 * Smoke test Video Studio KHÃ”NG cáº§n 4Seller/Gemini: áº£nh máº«u trong repo +
 * script hardcode + Edge TTS tháº­t + render ffmpeg tháº­t.
 * Usage: npx tsx src/scripts/testVideoRender.ts [--no-tts]
 *   --no-tts: bá» qua Edge TTS (offline), dÃ¹ng words Æ°á»›c lÆ°á»£ng trÃªn audio im láº·ng.
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
  if (images.length < 3) throw new Error(`Cáº§n â‰¥3 áº£nh máº«u trong ${SAMPLE_DIR}`);
  console.log(`ðŸ–¼ï¸ ${images.length} áº£nh máº«u`);

  const text = scriptToText(SCRIPT);
  const voicePath = path.join(OUT_DIR, "voice.mp3");
  let words, durationMs;
  if (noTts) {
    durationMs = 20000;
    await makeSilence(voicePath, durationMs / 1000);
    words = estimateWordTimings(text, durationMs);
    console.log("ðŸ”‡ --no-tts: audio im láº·ng 20s + words Æ°á»›c lÆ°á»£ng");
  } else {
    const voice = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
    console.log(`ðŸŽ™ï¸ Edge TTS voice=${voice}â€¦`);
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
  console.log(`ðŸŽ¬ Render ${plan.n} segments, ${plan.totalSec}sâ€¦`);
  const t0 = Date.now();
  await renderVideo({ images: segImages, plan, voicePath, musicPath: null, assPath, outPath, seed });
  console.log(`âœ… Xong sau ${Math.round((Date.now() - t0) / 1000)}s â†’ ${outPath}`);
};

main().catch((e) => { console.error("âŒ", e?.message ?? e); process.exit(1); });
```

- [x] **Step 3: Cháº¡y smoke test offline trÆ°á»›c**

Run: `npx tsx src/scripts/testVideoRender.ts --no-tts`
Expected: `âœ… Xong sau Ns â†’ ...data\videos\_smoke\smoke.mp4`. Náº¿u FFmpeg exit â‰  0: Ä‘á»c stderr trong message â€” lá»—i thÆ°á»ng gáº·p lÃ  filtergraph syntax hoáº·c font ASS; sá»­a `renderPlan.ts`/`buildAss.ts` cho tá»›i khi render Ä‘Æ°á»£c, cháº¡y láº¡i unit tests sau khi sá»­a.

- [x] **Step 4: Cháº¡y smoke test vá»›i TTS tháº­t**

Run: `npx tsx src/scripts/testVideoRender.ts`
Expected: log sá»‘ words tá»« TTS, render OK. Náº¿u Edge TTS lá»—i 403/timeout cáº£ 3 láº§n: kiá»ƒm tra version msedge-tts má»›i nháº¥t (`npm view msedge-tts version`), upgrade náº¿u cáº§n. ÄÃ¢y lÃ  Ä‘iá»ƒm rá»§i ro Ä‘Ã£ ghi á»Ÿ spec Â§8.

- [x] **Step 5: Má»Ÿ file `data/videos/_smoke/smoke.mp4` xem báº±ng máº¯t** â€” caption hiá»‡n Ä‘Ãºng nhá»‹p, zoom mÆ°á»£t, Ä‘á»§ 9:16. Chá»‰nh style/tham sá»‘ náº¿u tháº¥y xáº¥u rÃµ rÃ ng.

- [x] **Step 6: Commit**

```bash
git add src/core/videoStudio/renderVideo.ts src/scripts/testVideoRender.ts
git commit -m "feat(video-studio): ffmpeg runner + smoke test render that

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: KÃ©o áº£nh tá»« 4Seller (`fetchImages.ts`)

**Files:**
- Create: `src/core/videoStudio/fetchImages.ts`
- Test: `src/core/videoStudio/fetchImages.test.ts` (chá»‰ test pure `extractImageUrls`)

- [x] **Step 1: Viáº¿t test fail**

```ts
// src/core/videoStudio/fetchImages.test.ts
import { describe, it, expect } from "vitest";
import { extractImageUrls } from "./fetchImages";

describe("extractImageUrls", () => {
  it("detail.images lÃ  máº£ng string", () => {
    expect(extractImageUrls({ images: ["http://a/1.jpg", "http://a/2.jpg"] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images lÃ  máº£ng object {url} hoáº·c {imgUrl}", () => {
    expect(extractImageUrls({ images: [{ url: "http://a/1.jpg" }, { imgUrl: "http://a/2.jpg" }] }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("detail.images lÃ  chuá»—i phÃ¢n cÃ¡ch '|'", () => {
    expect(extractImageUrls({ images: "http://a/1.jpg|http://a/2.jpg" }, undefined))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("fallback mainImage khi detail khÃ´ng cÃ³ áº£nh; dedup; bá» chuá»—i rá»—ng", () => {
    expect(extractImageUrls({}, "http://a/1.jpg|http://a/1.jpg||http://a/2.jpg"))
      .toEqual(["http://a/1.jpg", "http://a/2.jpg"]);
  });
  it("khÃ´ng cÃ³ gÃ¬ â†’ máº£ng rá»—ng", () => {
    expect(extractImageUrls(null, undefined)).toEqual([]);
  });
});
```

- [x] **Step 2: Cháº¡y test â€” pháº£i FAIL**

Run: `npx vitest run src/core/videoStudio/fetchImages.test.ts`
Expected: FAIL â€” "Cannot find module './fetchImages'"

- [x] **Step 3: Implement**

```ts
// src/core/videoStudio/fetchImages.ts
/**
 * KÃ©o áº£nh sáº£n pháº©m tá»« 4Seller cho 1 video:
 *   getListingDetail â†’ images[] â†’ download (cache theo productId)
 *   â†’ sharp cover-crop 1080x1920 (position attention) â†’ remakeImage chá»‘ng trÃ¹ng
 * áº¢nh gá»‘c cache á»Ÿ assets/<productId>/src_N.jpg (dÃ¹ng chung má»i video),
 * áº£nh Ä‘Ã£ xá»­ lÃ½ á»Ÿ assets/<productId>/<videoId>/img_N.jpg (per-video vÃ¬ seed khÃ¡c).
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

/** BÃ³c URL áº£nh tá»« detail 4Seller (máº£ng string / máº£ng object / chuá»—i '|'), fallback mainImage cá»§a list record. */
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

  // áº¢nh Ä‘Ã£ xá»­ lÃ½ Ä‘á»§ tá»« láº§n cháº¡y trÆ°á»›c (retry) â†’ tÃ¡i dÃ¹ng
  const existing = (await fs.readdir(outDir)).filter((f) => /^img_\d+\.jpg$/.test(f)).sort();
  if (existing.length >= MIN_IMAGES) {
    return { files: existing.map((f) => path.join(outDir, f)), dir: outDir };
  }

  // 1. Láº¥y URL áº£nh (cache src trÆ°á»›c, chá»‰ gá»i API khi cache thiáº¿u)
  let srcFiles = (await fs.pathExists(srcDir))
    ? (await fs.readdir(srcDir)).filter((f) => /^src_\d+\.jpg$/.test(f)).sort().map((f) => path.join(srcDir, f))
    : [];
  if (srcFiles.length < MIN_IMAGES) {
    const detail = await getListingDetail(opts.principal, opts.listingId).catch((e) => {
      console.warn(`âš ï¸ [Images] getListingDetail lá»—i: ${e?.message} â†’ thá»­ mainImage`);
      return null;
    });
    const urls = extractImageUrls(detail, opts.mainImage).slice(0, MAX_IMAGES);
    if (urls.length < MIN_IMAGES) throw new Error(`Chá»‰ tÃ¬m tháº¥y ${urls.length} áº£nh (cáº§n â‰¥${MIN_IMAGES})`);
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
        console.warn(`âš ï¸ [Images] Táº£i áº£nh ${i} lá»—i: ${e?.message}`);
      }
    }
    if (srcFiles.length < MIN_IMAGES) throw new Error(`Táº£i Ä‘Æ°á»£c ${srcFiles.length}/${urls.length} áº£nh (lá»—i ${failed}), cáº§n â‰¥${MIN_IMAGES}`);
  }

  // 2. Cover-crop 1080x1920 + remake chá»‘ng trÃ¹ng (seed per-video per-áº£nh)
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

- [x] **Step 4: Cháº¡y test + typecheck â€” pháº£i PASS**

Run: `npx vitest run src/core/videoStudio/fetchImages.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck sáº¡ch. Náº¿u `sharp.strategy.attention` sai type: dÃ¹ng `position: "attention"`.

- [x] **Step 5: Commit**

```bash
git add src/core/videoStudio/fetchImages.ts src/core/videoStudio/fetchImages.test.ts
git commit -m "feat(video-studio): keo anh 4Seller + sharp 9:16 + remake chong trung

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Äá» xuáº¥t sáº£n pháº©m (`suggestProducts.ts` + `listTrackedShops`)

**Files:**
- Modify: `src/services/tiktok/db.ts` (thÃªm method trÆ°á»›c `close()`)
- Create: `src/core/videoStudio/suggestProducts.ts`
- Test: `src/core/videoStudio/suggestProducts.test.ts` (test pure join)

- [x] **Step 1: ThÃªm `listTrackedShops` vÃ o TiktokDb**

Trong `src/services/tiktok/db.ts`, thÃªm method ngay TRÆ¯á»šC `close(): void {`:

```ts
  /** Danh sÃ¡ch shop cÃ³ data listing_views (dropdown Video Studio). */
  listTrackedShops(): string[] {
    return (this.db
      .prepare(`SELECT DISTINCT shop FROM listing_views WHERE shop != '' ORDER BY shop`)
      .all() as { shop: string }[]).map((r) => r.shop);
  }
```

- [x] **Step 2: Viáº¿t test fail cho join**

```ts
// src/core/videoStudio/suggestProducts.test.ts
import { describe, it, expect } from "vitest";
import { joinCandidatesWithListings } from "./suggestProducts";

const cands = [
  { productId: "P1", productName: "Dress A", pv: 900, avgPerDay: 40, daysTracked: 5, orders: 3, stock: 10, converting: true, reasons: ["cÃ³ Ä‘Æ¡n"] },
  { productId: "P2", productName: "Top B", pv: 600, avgPerDay: 25, daysTracked: 4, orders: 0, stock: 5, converting: false, reasons: ["Ä‘ang lÃªn"] },
  { productId: "P404", productName: "Gone", pv: 100, avgPerDay: 20, daysTracked: 3, orders: 0, stock: 1, converting: false, reasons: ["Ä‘ang lÃªn"] },
];
const listingIndex = new Map([
  ["P1", { listingId: "L1", title: "Dress A full", mainImage: "http://i/1.jpg|http://i/2.jpg" }],
  ["P2", { listingId: "L2", title: "Top B full", mainImage: "http://i/3.jpg" }],
]);

describe("joinCandidatesWithListings", () => {
  it("match theo productId, láº¥y listingId + thumb (áº£nh Ä‘áº§u cá»§a mainImage)", () => {
    const { items, unmatched } = joinCandidatesWithListings(cands as any, listingIndex);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ productId: "P1", listingId: "L1", thumb: "http://i/1.jpg", reasons: ["cÃ³ Ä‘Æ¡n"] });
    expect(unmatched).toBe(1); // P404 khÃ´ng cÃ²n active trÃªn 4Seller
  });
});
```

Run: `npx vitest run src/core/videoStudio/suggestProducts.test.ts`
Expected: FAIL â€” "Cannot find module './suggestProducts'"

- [x] **Step 3: Implement**

```ts
// src/core/videoStudio/suggestProducts.ts
/**
 * Äá» xuáº¥t sáº£n pháº©m lÃ m video: candidates tÃ­n hiá»‡u view/sold tá»« listing_views
 * (getFlashCandidates â€” cÃ³ Ä‘Æ¡n / Ä‘ang lÃªn / nhiá»u view, kÃ¨m reasons) JOIN vá»›i
 * listing active trÃªn 4Seller (láº¥y listingId + mainImage). Pattern principal
 * + shopId GIá»NG flashDeal.ts.
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

/** Pure join Ä‘á»ƒ unit-test: candidates Ã— index(productIdâ†’listing). */
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

  // 1. Principal + shopId (giá»‘ng flashDeal)
  const account = await resolveAccountForShop(shop);
  if (!account) throw new Error(`Shop "${shop}" khÃ´ng thuá»™c tÃ i khoáº£n 4Seller nÃ o (tab Cookie 4Seller).`);
  const principal = `acct:${account.uid}`;
  const shopList = await getShopList(principal);
  const rec = (shopList?.records ?? []).find((s: any) => s.shopName === shop);
  if (!rec) throw new Error(`KhÃ´ng tháº¥y shop "${shop}" trong 4Seller (tÃ i khoáº£n ${account.label}).`);
  const shopId = Number(rec.id);

  // 2. Candidates tá»« tÃ­n hiá»‡u view/sold
  const tdb = new TiktokDb();
  let cand;
  try { cand = tdb.getFlashCandidates(shop, { limit }); } finally { tdb.close(); }
  if (!cand.candidates.length) return { shop, latestDate: cand.latestDate, items: [], unmatched: 0 };

  // 3. Index listing active theo productId (paginate háº¿t)
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

  // 4. Join + cá» hasVideo
  const { items, unmatched } = joinCandidatesWithListings(cand.candidates, index);
  if (unmatched) console.warn(`âš ï¸ [Suggest] ${unmatched} sp cÃ³ tÃ­n hiá»‡u nhÆ°ng khÃ´ng cÃ²n active trÃªn 4Seller (${shop})`);
  const vdb = new VideoDb();
  try {
    return {
      shop, latestDate: cand.latestDate, unmatched,
      items: items.map((it) => ({ ...it, hasVideo: vdb.hasReadyVideo(it.productId) })),
    };
  } finally { vdb.close(); }
}
```

- [x] **Step 4: Cháº¡y test + typecheck â€” pháº£i PASS**

Run: `npx vitest run src/core/videoStudio/suggestProducts.test.ts && npm run typecheck`
Expected: PASS (1 test), typecheck sáº¡ch. LÆ°u Ã½: field title cá»§a ListingRecord cÃ³ thá»ƒ tÃªn khÃ¡c (`productName`) â€” code Ä‘Ã£ fallback cáº£ 2; náº¿u typecheck bÃ¡o field khÃ´ng tá»“n táº¡i trÃªn ListingRecord thÃ¬ record lÃ  `[k: string]: any` nÃªn váº«n pass.

- [x] **Step 5: Commit**

```bash
git add src/services/tiktok/db.ts src/core/videoStudio/suggestProducts.ts src/core/videoStudio/suggestProducts.test.ts
git commit -m "feat(video-studio): de xuat san pham tiem nang (join listing_views x 4Seller)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Queue pipeline (`videoQueue.ts`)

**Files:**
- Create: `src/core/videoStudio/videoQueue.ts`

Orchestration má»ng â€” má»i logic Ä‘Ã£ test á»Ÿ cÃ¡c task trÆ°á»›c. Verify qua route + UI (Task 12) vÃ  smoke á»Ÿ Task 8.

- [x] **Step 1: Implement**

```ts
// src/core/videoStudio/videoQueue.ts
/**
 * Queue tuáº§n tá»± Video Studio (1 render 1 lÃºc â€” ffmpeg Äƒn full CPU).
 * Pipeline per video: images â†’ script â†’ tts â†’ render. Artifacts trÃªn disk
 * (áº£nh/script/voice) tÃ¡i dÃ¹ng khi retry â€” cháº¡y láº¡i tá»« step fail.
 * Progress qua console.log (Ä‘Ã£ tap vÃ o eventBus â†’ SSE cá»§a admin).
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

  /** Táº¡o rows queued + kick worker. Tráº£ vá» ids. */
  enqueue(shop: string, items: CreateVideoItem[]): number[] {
    const db = new VideoDb();
    try {
      const ids = items.map((it) => {
        const id = db.create({
          shop, productId: it.productId, listingId: it.listingId, title: it.title,
          seed: `${it.productId}:${Date.now() % 1_000_000}`,
        });
        // mainImage cache Ä‘á»ƒ fetchImages fallback khi detail khÃ´ng tráº£ áº£nh
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
      if (!row) throw new Error(`KhÃ´ng cÃ³ video #${id}`);
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
        console.error(`âŒ [Video #${next.id}] ${e?.message ?? e}`);
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
      if (!account) throw new Error(`Shop "${row.shop}" khÃ´ng cÃ³ tÃ i khoáº£n 4Seller`);
      const principal = `acct:${account.uid}`;
      const workDir = path.join(ASSETS_DIR, row.product_id, String(id));
      await fs.ensureDir(workDir);

      let step = "images";
      try {
        // â”€â”€ 1. áº¢nh â”€â”€
        db.setStatus(id, { status: "generating", step });
        console.log(`ðŸŽ¬ [Video #${id}] ${row.title.slice(0, 50)} â€” bÆ°á»›c áº£nh`);
        const mainImageFile = path.join(ASSETS_DIR, row.product_id, "mainImage.txt");
        const mainImage = (await fs.pathExists(mainImageFile)) ? await fs.readFile(mainImageFile, "utf-8") : undefined;
        const { files: images } = await fetchImages({
          principal, listingId: row.listing_id, productId: row.product_id,
          videoId: id, seed, mainImage,
        });
        console.log(`   âœ… ${images.length} áº£nh`);

        // â”€â”€ 2. Script (tÃ¡i dÃ¹ng náº¿u Ä‘Ã£ cÃ³) â”€â”€
        step = "script";
        db.setStatus(id, { status: "generating", step });
        let script: VideoScript;
        if (row.script_json) {
          script = validateScript(JSON.parse(row.script_json));
          console.log(`   ðŸ’¾ TÃ¡i dÃ¹ng script cÅ©`);
        } else {
          script = await genVideoScript(row.title);
          db.setScript(id, JSON.stringify(script));
          console.log(`   âœ… Script: "${script.hook}"`);
        }

        // â”€â”€ 3. TTS (tÃ¡i dÃ¹ng náº¿u voice.mp3 + words.json Ä‘Ã£ cÃ³) â”€â”€
        step = "tts";
        db.setStatus(id, { status: "generating", step });
        const voicePath = path.join(workDir, "voice.mp3");
        const wordsPath = path.join(workDir, "words.json");
        let words, durationMs, voiceName;
        if ((await fs.pathExists(voicePath)) && (await fs.pathExists(wordsPath))) {
          ({ words, durationMs, voiceName } = await fs.readJson(wordsPath));
          console.log(`   ðŸ’¾ TÃ¡i dÃ¹ng voice cÅ© (${voiceName})`);
        } else {
          voiceName = seededPick(seededRng(`voice:${seed}`), VOICE_POOL);
          const r = await edgeTtsEngine.synthesize(scriptToText(script), voiceName, voicePath);
          words = r.words; durationMs = r.durationMs;
          await fs.writeJson(wordsPath, { words, durationMs, voiceName });
          console.log(`   âœ… TTS ${voiceName}, ${Math.round(durationMs / 1000)}s`);
        }
        db.setStatus(id, { status: "generating", step, voice: voiceName });

        // â”€â”€ 4. Render â”€â”€
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
        console.log(`   ðŸŽ¬ Render ${plan.n} segments, ${plan.totalSec}s${music ? ", nháº¡c: " + path.basename(music) : ", khÃ´ng nháº¡c"}`);
        await renderVideo({ images: segImages, plan, voicePath, musicPath: music, assPath, outPath, seed });

        db.setStatus(id, { status: "ready", file: outPath });
        console.log(`âœ… [Video #${id}] READY â†’ ${outPath}`);
      } catch (e: any) {
        db.setStatus(id, { status: "error", step, error: String(e?.message ?? e).slice(0, 500) });
        console.error(`âŒ [Video #${id}] bÆ°á»›c "${step}": ${e?.message ?? e}`);
      }
    } finally { db.close(); }
  }
}

async function pickMusic(rng: () => number): Promise<string | null> {
  try {
    const files = (await fs.readdir(MUSIC_DIR)).filter((f) => /\.mp3$/i.test(f));
    if (!files.length) return null;
    return path.join(MUSIC_DIR, seededPick(rng, files));
  } catch { return null; } // thÆ° má»¥c chÆ°a tá»“n táº¡i â†’ khÃ´ng nháº¡c, khÃ´ng lá»—i
}

export const videoQueue = new VideoQueue();
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add src/core/videoStudio/videoQueue.ts
git commit -m "feat(video-studio): queue tuan tu pipeline images->script->tts->render

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Routes + UI (`routes.ts`, `videos.html`, sá»­a `adminServer.ts`)

**Files:**
- Create: `src/core/videoStudio/routes.ts`
- Create: `src/public/videos.html`
- Modify: `src/adminServer.ts` (2 chá»—: import + 2 dÃ²ng Ä‘Äƒng kÃ½, Ä‘áº·t cáº¡nh route `/admin` hiá»‡n cÃ³ ~dÃ²ng 137)

- [x] **Step 1: Implement routes**

```ts
// src/core/videoStudio/routes.ts
/**
 * Routes Video Studio, mount vÃ o admin server (Ä‘Ã£ qua requireAuth vÃ¬
 * path /admin/api/*). TÃ¡ch file riÃªng Ä‘á»ƒ adminServer.ts khÃ´ng phÃ¬nh thÃªm.
 */
import type express from "express";
import fs from "fs-extra";
import path from "path";
import { VideoDb } from "../../state/videoDb";
import { TiktokDb } from "../../services/tiktok/db";
import { suggestProducts } from "./suggestProducts";
import { videoQueue, CreateVideoItem } from "./videoQueue";

export function registerVideoRoutes(app: express.Express): void {
  // Shops cÃ³ data view Ä‘á»ƒ Ä‘á» xuáº¥t
  app.get("/admin/api/videos/shops", (_req, res) => {
    const db = new TiktokDb();
    try { res.json({ shops: db.listTrackedShops() }); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
    finally { db.close(); }
  });

  // Äá» xuáº¥t sáº£n pháº©m tiá»m nÄƒng cá»§a 1 shop
  app.get("/admin/api/videos/suggest", async (req, res) => {
    try {
      const shop = String(req.query.shop ?? "");
      if (!shop) return res.status(400).json({ error: "Thiáº¿u ?shop=" });
      const limit = Math.min(200, parseInt(String(req.query.limit ?? "50")) || 50);
      res.json(await suggestProducts(shop, { limit }));
    } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
  });

  // Enqueue táº¡o video
  app.post("/admin/api/videos/create", (req, res) => {
    try {
      const { shop, items } = req.body as { shop: string; items: CreateVideoItem[] };
      if (!shop || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: "Cáº§n {shop, items:[{productId,listingId,title}]}" });
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
      if (!row?.file || !fs.pathExistsSync(row.file)) return res.status(404).json({ error: "ChÆ°a cÃ³ file" });
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

  // XÃ³a row + file mp4 (giá»¯ assets cache áº£nh cá»§a sáº£n pháº©m)
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

- [x] **Step 2: Sá»­a `adminServer.ts`**

ThÃªm import cáº¡nh cÃ¡c import hiá»‡n cÃ³ Ä‘áº§u file:

```ts
import { registerVideoRoutes } from "./core/videoStudio/routes";
```

ThÃªm route trang + Ä‘Äƒng kÃ½ API, Ä‘áº·t NGAY SAU block `app.get("/admin", ...)` (hiá»‡n ~dÃ²ng 137-142):

```ts
  app.get("/admin/videos", (req, res) => {
    if (req.session && (req.session as any).user) {
      return res.sendFile(path.join(__dirname, "public", "videos.html"));
    }
    return res.redirect("/admin/login");
  });
  registerVideoRoutes(app);
```

- [x] **Step 3: Táº¡o `videos.html`**

Style tá»‘i giáº£n khá»›p tÃ´ng admin hiá»‡n cÃ³ (dark, CSS variables). Polling 4s thay vÃ¬ SSE (Ä‘Æ¡n giáº£n, Ä‘á»§ dÃ¹ng); log realtime Ä‘Ã£ cÃ³ á»Ÿ trang admin chÃ­nh.

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
  <h1>ðŸŽ¬ Video Studio</h1>
  <a href="/admin">â† Admin</a>
</header>
<div class="tabs">
  <div class="tab active" data-tab="suggest">ðŸ’¡ Äá» xuáº¥t</div>
  <div class="tab" data-tab="library">ðŸ“š ThÆ° viá»‡n</div>
</div>
<main>
  <section id="tab-suggest">
    <div class="bar">
      <select id="shopSel"><option value="">â€” chá»n shop â€”</option></select>
      <button id="btnSuggest" class="primary">Äá» xuáº¥t sáº£n pháº©m</button>
      <button id="btnCreate" disabled>ðŸŽ¬ Táº¡o video cho má»¥c Ä‘Ã£ chá»n</button>
      <span id="suggestInfo" style="color:var(--text-mute)"></span>
    </div>
    <div id="suggestBody" class="empty">Chá»n shop rá»“i báº¥m "Äá» xuáº¥t sáº£n pháº©m".</div>
  </section>
  <section id="tab-library" style="display:none">
    <div class="bar">
      <select id="libShop"><option value="">Táº¥t cáº£ shop</option></select>
      <select id="libStatus">
        <option value="">Táº¥t cáº£ status</option>
        <option>queued</option><option>generating</option><option>ready</option><option>error</option><option>posted</option>
      </select>
    </div>
    <div id="libBody" class="empty">Äang táº£iâ€¦</div>
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
  } catch (e) { $("#suggestInfo").textContent = "Lá»—i táº£i shops: " + e.message; }
})();

// â”€â”€ Äá» xuáº¥t â”€â”€
$("#btnSuggest").onclick = async () => {
  const shop = $("#shopSel").value;
  if (!shop) return alert("Chá»n shop trÆ°á»›c");
  $("#suggestBody").innerHTML = '<div class="empty">Äang phÃ¢n tÃ­ch tÃ­n hiá»‡u view/soldâ€¦</div>';
  $("#btnCreate").disabled = true;
  try {
    currentSuggest = await api(`/admin/api/videos/suggest?shop=${encodeURIComponent(shop)}`);
    const { items, latestDate, unmatched } = currentSuggest;
    $("#suggestInfo").textContent = `${items.length} sp tiá»m nÄƒng Â· data ${latestDate ?? "?"}${unmatched ? ` Â· ${unmatched} sp háº¿t active` : ""}`;
    if (!items.length) { $("#suggestBody").innerHTML = '<div class="empty">KhÃ´ng cÃ³ sáº£n pháº©m nÃ o Ä‘á»§ tÃ­n hiá»‡u (cáº§n cháº¡y crawl view háº±ng ngÃ y).</div>'; return; }
    $("#suggestBody").innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="chkAll"></th><th></th><th>Sáº£n pháº©m</th>
      <th>Views 28d</th><th>ÄÃ /ngÃ y</th><th>ÄÆ¡n 28d</th><th>TÃ­n hiá»‡u</th><th>Video</th>
    </tr></thead><tbody>${items.map((it, i) => `<tr>
      <td><input type="checkbox" class="chk" data-i="${i}" ${it.hasVideo ? "" : "checked"}></td>
      <td>${it.thumb ? `<img src="${esc(it.thumb)}" loading="lazy">` : ""}</td>
      <td>${esc(it.title)}<div class="mono" style="color:var(--text-mute);font-size:0.72rem">${esc(it.productId)}</div></td>
      <td class="mono">${it.pv}</td><td class="mono">+${it.avgPerDay}</td><td class="mono">${it.orders}</td>
      <td>${(it.reasons || []).map((r) => `<span class="reason">${esc(r)}</span>`).join("")}</td>
      <td>${it.hasVideo ? "âœ… cÃ³" : "â€”"}</td>
    </tr>`).join("")}</tbody></table>`;
    $("#chkAll").onchange = (e) => document.querySelectorAll(".chk").forEach((c) => { c.checked = e.target.checked; updateCreateBtn(); });
    document.querySelectorAll(".chk").forEach((c) => c.onchange = updateCreateBtn);
    updateCreateBtn();
  } catch (e) { $("#suggestBody").innerHTML = `<div class="empty">âŒ ${esc(e.message)}</div>`; }
};
const updateCreateBtn = () => {
  const n = document.querySelectorAll(".chk:checked").length;
  $("#btnCreate").disabled = !n;
  $("#btnCreate").textContent = n ? `ðŸŽ¬ Táº¡o video cho ${n} sáº£n pháº©m` : "ðŸŽ¬ Táº¡o video cho má»¥c Ä‘Ã£ chá»n";
};
$("#btnCreate").onclick = async () => {
  const idx = [...document.querySelectorAll(".chk:checked")].map((c) => +c.dataset.i);
  const items = idx.map((i) => {
    const it = currentSuggest.items[i];
    return { productId: it.productId, listingId: it.listingId, title: it.title, mainImage: it.thumb };
  });
  try {
    const r = await api("/admin/api/videos/create", { method: "POST", body: JSON.stringify({ shop: $("#shopSel").value, items }) });
    alert(`ÄÃ£ Ä‘Æ°a ${r.queued} video vÃ o hÃ ng Ä‘á»£i`);
    document.querySelector('[data-tab="library"]').click();
  } catch (e) { alert("âŒ " + e.message); }
};

// â”€â”€ ThÆ° viá»‡n â”€â”€
let libTimer = null;
async function loadLibrary() {
  clearTimeout(libTimer);
  try {
    const q = new URLSearchParams();
    if ($("#libShop").value) q.set("shop", $("#libShop").value);
    if ($("#libStatus").value) q.set("status", $("#libStatus").value);
    const { videos } = await api("/admin/api/videos?" + q);
    if (!videos.length) { $("#libBody").innerHTML = '<div class="empty">ChÆ°a cÃ³ video nÃ o.</div>'; }
    else {
      $("#libBody").innerHTML = `<div class="grid">${videos.map((v) => `<div class="card">
        ${v.status === "ready" || v.status === "posted"
          ? `<video src="/admin/api/videos/file/${v.id}" controls preload="metadata"></video>`
          : `<div style="aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;background:#000;border-radius:8px;color:var(--text-mute)">${v.status === "generating" ? "â³ " + esc(v.step ?? "") : esc(v.status)}</div>`}
        <div class="t">${esc(v.title)}</div>
        <span class="badge b-${esc(v.status)}">${esc(v.status)}${v.status === "generating" && v.step ? " Â· " + esc(v.step) : ""}</span>
        <span style="color:var(--text-mute);font-size:0.72rem"> #${v.id} Â· ${esc(v.shop)}</span>
        ${v.error ? `<div class="err-detail">${esc(v.error)}</div>` : ""}
        <div class="actions">
          ${v.status === "ready" || v.status === "posted" ? `<a href="/admin/api/videos/file/${v.id}" download="video_${v.id}.mp4"><button>â¬‡ Táº£i</button></a>` : ""}
          ${v.status === "ready" ? `<button onclick="markPosted(${v.id})">âœ… ÄÃ£ Ä‘Äƒng</button>` : ""}
          ${v.status === "error" ? `<button onclick="retryVid(${v.id})">ðŸ”„ Retry</button>` : ""}
          <button onclick="delVid(${v.id})">ðŸ—‘</button>
        </div>
      </div>`).join("")}</div>`;
    }
    // Ä‘ang cÃ³ job cháº¡y â†’ poll tiáº¿p
    if (videos.some((v) => v.status === "queued" || v.status === "generating")) libTimer = setTimeout(loadLibrary, 4000);
  } catch (e) { $("#libBody").innerHTML = `<div class="empty">âŒ ${esc(e.message)}</div>`; }
}
$("#libShop").onchange = loadLibrary;
$("#libStatus").onchange = loadLibrary;
window.markPosted = async (id) => { await api(`/admin/api/videos/${id}/posted`, { method: "POST", body: "{}" }); loadLibrary(); };
window.retryVid = async (id) => { await api(`/admin/api/videos/${id}/retry`, { method: "POST", body: "{}" }); loadLibrary(); };
window.delVid = async (id) => { if (confirm("XÃ³a video #" + id + "?")) { await api(`/admin/api/videos/${id}`, { method: "DELETE" }); loadLibrary(); } };
</script>
</body>
</html>
```

- [x] **Step 4: Typecheck + toÃ n bá»™ test**

Run: `npm run typecheck && npx vitest run`
Expected: cáº£ 2 PASS (bao gá»“m má»i test cÅ© cá»§a project â€” khÃ´ng phÃ¡ gÃ¬).

- [x] **Step 5: Verify end-to-end báº±ng tay**

1. `npm run dev` (server admin cháº¡y nhÆ° bÃ¬nh thÆ°á»ng).
2. Má»Ÿ `http://localhost:<port>/admin/videos` (port nhÆ° admin hiá»‡n cÃ³) â†’ login â†’ tháº¥y trang Video Studio.
3. Tab Äá» xuáº¥t: chá»n 1 shop cÃ³ data view â†’ báº¥m Äá» xuáº¥t â†’ tháº¥y báº£ng sp kÃ¨m reasons.
4. Tick 1 sáº£n pháº©m â†’ Táº¡o video â†’ tab ThÆ° viá»‡n tháº¥y status cháº¡y `images â†’ script â†’ tts â†’ render` â†’ `ready` â†’ preview video ngay trong trang, báº¥m Táº£i.
5. Náº¿u lá»—i á»Ÿ step nÃ o â†’ card hiá»‡n message Ä‘á» + nÃºt Retry.

- [x] **Step 6: Commit**

```bash
git add src/core/videoStudio/routes.ts src/public/videos.html src/adminServer.ts
git commit -m "feat(video-studio): routes /admin/api/videos + UI de xuat & thu vien

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: HoÃ n táº¥t â€” docs ngáº¯n + kiá»ƒm tra cuá»‘i

**Files:**
- Modify: `docs/ARCHITECTURE.md` (thÃªm má»¥c Video Studio â€” 5-8 dÃ²ng mÃ´ táº£ module + Ä‘Æ°á»ng dáº«n file, theo vÄƒn phong file hiá»‡n cÃ³)

- [x] **Step 1: ThÃªm má»¥c Video Studio vÃ o `docs/ARCHITECTURE.md`** â€” mÃ´ táº£: má»¥c Ä‘Ã­ch, luá»“ng 6 bÆ°á»›c nhÆ° spec Â§3, vá»‹ trÃ­ data (`data/videos.db`, `data/videos/<shop>/*.mp4`, `data/videos/music/`), trang `/admin/videos`.

- [x] **Step 2: Cháº¡y toÃ n bá»™ verify láº§n cuá»‘i**

Run: `npm run typecheck && npx vitest run`
Expected: PASS toÃ n bá»™.

- [x] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: them muc Video Studio vao ARCHITECTURE

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review (Ä‘Ã£ cháº¡y khi viáº¿t plan)

- **Spec coverage:** Â§4.1â†’Task 10, Â§4.2â†’Task 9, Â§4.3â†’Task 5, Â§4.4â†’Tasks 3+4, Â§4.5â†’Task 6, Â§4.6â†’Tasks 7+8, Â§4.7â†’Task 2, Â§4.8â†’Task 11, Â§4.9â†’Task 12, Â§5 (nháº¡c/font/principal)â†’Tasks 11+12, Â§6 error handlingâ†’Tasks 4/8/9/11, Â§7 testingâ†’má»—i task + Task 8 smoke. Äá»§.
- **Type consistency:** `TtsWord`/`TtsResult` (Task 3/4) dÃ¹ng xuyÃªn suá»‘t; `VideoScript`+`scriptToText`+`validateScript` (Task 5) dÃ¹ng á»Ÿ Task 8/11; `SegmentPlan`+`buildFfmpegArgs`+`FfmpegArgsOpts` (Task 7) dÃ¹ng á»Ÿ Task 8/11; `VideoDb` API (Task 2) khá»›p cÃ¡ch gá»i á»Ÿ Task 11/12; `CreateVideoItem` (Task 11) khá»›p routes/UI (Task 12).
- **Äiá»ƒm rá»§i ro cÃ³ hÆ°á»›ng xá»­ lÃ½ trong plan:** API msedge-tts khÃ¡c version (Task 4 Step 3 + Task 8 Step 4), field `title` cá»§a ListingRecord (Task 10 Step 4), filtergraph/font lá»—i (Task 8 Step 3).
