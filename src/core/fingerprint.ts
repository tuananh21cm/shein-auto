/**
 * fingerprint — anti-detect: sinh fingerprint Chrome/desktop THẬT + nhất quán (Apify
 * fingerprint-generator) rồi inject vào 1 BrowserContext Playwright (fingerprint-injector):
 * mask navigator.webdriver, spoof UA/screen/WebGL/canvas/plugins/languages/hardwareConcurrency…
 * Mỗi context (mỗi proxy) 1 fingerprint riêng → mỗi worker trông như 1 máy thật khác nhau.
 */
import { FingerprintGenerator, type BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import type { BrowserContext } from "playwright-core";

const generator = new FingerprintGenerator({
  browsers: [{ name: "chrome", minVersion: 118 }],
  devices: ["desktop"],
  operatingSystems: ["windows", "macos"],
  locales: ["en-US"],
});
const injector = new FingerprintInjector();

export type Fp = BrowserFingerprintWithHeaders;

/** Sinh 1 fingerprint ngẫu nhiên (gọi mỗi lần rotate proxy/session). */
export const newFingerprint = (): Fp => generator.getFingerprint();

/** Options cho launchPersistentContext lấy từ fingerprint (UA/viewport/locale khớp nhau). */
export function fpContextOptions(fp: Fp): {
  userAgent: string; viewport: { width: number; height: number }; locale: string; deviceScaleFactor: number;
} {
  const nav: any = fp.fingerprint.navigator;
  const scr: any = fp.fingerprint.screen;
  return {
    userAgent: nav.userAgent,
    // viewport (cửa sổ) < screen là bình thường; cap để không mở full màn.
    viewport: { width: Math.min(scr.width || 1366, 1536), height: Math.min(scr.height || 864, 900) },
    locale: (Array.isArray(nav.languages) && nav.languages[0]) || "en-US",
    deviceScaleFactor: scr.devicePixelRatio || 1,
  };
}

/** Gắn fingerprint (init scripts mask + headers) vào context — gọi ngay sau khi launch. */
export async function applyFingerprint(context: BrowserContext, fp: Fp): Promise<void> {
  await injector.attachFingerprintToPlaywright(context as any, fp);
}
