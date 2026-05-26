import { EventEmitter } from "events";

/**
 * EventBus là singleton để các module phát/lắng nghe event runtime:
 *  - "log"          : { level, message, ts }   — pipe console.log
 *  - "worker:state" : current job snapshot
 *  - "history"      : success/fail entry mới
 *  - "queue"        : queue snapshot mới
 *
 * SSE handler ở Admin UI subscribe vào đây để stream xuống browser.
 */
class EventBus extends EventEmitter {
  emitLog(level: "info" | "warn" | "error", message: string) {
    this.emit("log", { level, message, ts: Date.now() });
  }
}

export const eventBus = new EventBus();
eventBus.setMaxListeners(50);

/**
 * Patch console.log/warn/error để mỗi log đẩy lên eventBus → SSE stream.
 * Vẫn giữ output ra terminal bình thường.
 */
let installed = false;
export const installConsoleTap = (): void => {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const fmt = (args: any[]): string =>
    args
      .map((a) => (typeof a === "string" ? a : (() => {
        try { return JSON.stringify(a); } catch { return String(a); }
      })()))
      .join(" ");

  console.log = (...args: any[]) => {
    origLog(...args);
    eventBus.emitLog("info", fmt(args));
  };
  console.warn = (...args: any[]) => {
    origWarn(...args);
    eventBus.emitLog("warn", fmt(args));
  };
  console.error = (...args: any[]) => {
    origError(...args);
    eventBus.emitLog("error", fmt(args));
  };
};
