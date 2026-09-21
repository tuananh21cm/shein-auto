import zlib from "zlib";
import type { RequestHandler } from "express";

/**
 * Nén gzip các response `res.json` lớn (zlib stdlib, khỏi thêm dependency `compression`).
 * /admin/api/hub trả ~3.4MB JSON cho ~4500 sp → gzip level 3 còn ~770KB (~50ms, async trong threadpool
 * nên không khoá event loop). Level 6 chỉ gọn thêm ~10% mà chậm gấp rưỡi.
 * Chỉ nén khi client nhận gzip và body >= MIN_BYTES; SSE/stream không đi qua res.json nên không ảnh hưởng.
 */
const MIN_BYTES = 8 * 1024;

export const gzipJson: RequestHandler = (req, res, next) => {
  if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) return next();
  const plainJson = res.json.bind(res);
  res.json = ((body: any) => {
    const buf = Buffer.from(JSON.stringify(body));
    if (buf.length < MIN_BYTES) return plainJson(body);
    zlib.gzip(buf, { level: 3 }, (err, gz) => {
      res.set("Content-Type", "application/json; charset=utf-8");
      res.set("Vary", "Accept-Encoding");
      if (err) { res.end(buf); return; }
      res.set("Content-Encoding", "gzip");
      res.end(gz);
    });
    return res;
  }) as typeof res.json;
  next();
};
