import { chromium } from "playwright-core";
import { kiki } from "../services/kiki/client";
import { ensureNoCaptcha } from "../services/kiki/captcha";
import { attachCaptureBus } from "../services/tiktok/captureBus";
import { ROUTES } from "../services/tiktok/routes";
import { TiktokDb } from "../services/tiktok/db";
import type { CrawlSnapshot, RouteMetrics, CrawlStatus, RouteDef } from "../services/tiktok/types";

export function isLoginWall(url: string): boolean {
  return /\/(account\/)?login|\/passport|\/signin/i.test(url);
}

export interface CrawlTiktokParams {
  profileId: string;
  db: TiktokDb;
  /** Bật discovery dump (data/_tiktok_discovery/<date>/). */
  discoverDir?: string;
  /** Danh sách route tùy biến (mặc định = ROUTES production). Dùng cho discovery phase 2. */
  routes?: RouteDef[];
  onLog?: (msg: string) => void;
}

/** Ngày địa phương dạng YYYY-MM-DD. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function humanScroll(page: any): Promise<void> {
  const step = 600 + Math.floor(Math.random() * 500);
  await page.mouse.wheel(0, step).catch(() => {});
  await page.waitForTimeout(700 + Math.floor(Math.random() * 900));
}

export async function crawlTiktokSeller(params: CrawlTiktokParams): Promise<CrawlSnapshot> {
  const { profileId, db, discoverDir } = params;
  const routeList = params.routes ?? ROUTES;
  const log = (m: string) => params.onLog?.(m);
  const runDate = todayStr();
  const startedAt = new Date().toISOString();
  const runId = db.startRun(runDate);

  log(`Force-stop profile ${profileId}…`);
  await kiki.forceStop(profileId);
  log(`Khởi động Kiki profile…`);
  const started = await kiki.startWithRetry(profileId, log);
  log(`Kết nối CDP (port ${started.debuggingPort})…`);
  const browser = await chromium.connectOverCDP(started.websocketDebuggerUrl);

  const routes: RouteMetrics[] = [];
  let status: CrawlStatus = "ok";
  let page: any;

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    const bus = attachCaptureBus(page, discoverDir ? { dumpDir: discoverDir } : {});

    for (const route of routeList) {
      bus.setRoute(route.key);
      bus.clear();
      const rm: RouteMetrics = { route: route.key, ok: false, metrics: [] };
      try {
        log(`→ ${route.key}: ${route.url}`);
        await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);

        if (isLoginWall(page.url())) {
          status = "login_required";
          rm.error = "login_required";
          routes.push(rm);
          log(`✗ Bị đẩy về trang login — cần đăng nhập lại trong cửa sổ Kiki.`);
          break;
        }

        if (route.skipCaptcha) {
          log(`  (capture-first: không chờ captcha, hứng data rồi đóng)`);
        } else {
          await ensureNoCaptcha(page, { onLog: log, context: `TikTok ${route.key}`, profileId });
        }
        if (route.waitForSelector) {
          await page.waitForSelector(route.waitForSelector, { timeout: 15_000 }).catch(() => {});
        }
        await humanScroll(page);
        if (route.waitForEndpoint) {
          // poll tới khi endpoint chỉ số fire (API analytics fire muộn), scroll nhẹ kích lazy-load
          const re = new RegExp(route.waitForEndpoint);
          const maxWait = route.settleMs ?? 20_000;
          const start = Date.now();
          while (Date.now() - start < maxWait && !bus.snapshot().some((c) => re.test(c.url))) {
            await page.mouse.wheel(0, 350).catch(() => {});
            await page.waitForTimeout(1500);
          }
          // grace: chờ thêm cho các endpoint phụ fire muộn kịp về (vd summary_info)
          await page.waitForTimeout(3000);
        } else {
          await page.waitForTimeout(route.settleMs ?? 3000);
        }

        const caps = bus.snapshot();
        for (const c of caps) db.insertRawCapture(runId, route.key, c.url, c.status);
        rm.metrics = route.extractor(caps);
        rm.ok = true;
        db.insertMetrics(runId, route.key, rm.metrics);
        log(`  ✓ ${rm.metrics.length} chỉ số (${caps.length} capture).`);
      } catch (e: any) {
        rm.error = e?.message ?? String(e);
        status = status === "ok" ? "partial" : status;
        log(`  ✗ Lỗi route ${route.key}: ${rm.error}`);
      }
      routes.push(rm);
    }
  } catch (e: any) {
    status = "error";
    log(`✗ Lỗi crawl: ${e?.message ?? e}`);
  } finally {
    try { if (page) await page.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
    await kiki.stopProfile(profileId);
    log(`Đã đóng & stop profile.`);
  }

  const finishedAt = new Date().toISOString();
  db.finishRun(runId, status);
  return { runId, runDate, startedAt, finishedAt, status, routes };
}
