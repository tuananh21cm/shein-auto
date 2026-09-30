import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { config } from "../config";

/**
 * Upload 1 file ảnh lên Cloudflare R2 (S3 API, ký SigV4 tay — khỏi cài @aws-sdk) → URL public.
 * Key theo md5 nội dung → upload lại file y hệt = cùng URL (idempotent, không tốn slot mới).
 * Trả null nếu chưa cấu hình R2_* trong .env hoặc upload lỗi (caller tự fallback).
 */
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif",
};

const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (data: crypto.BinaryLike) =>
  crypto.createHash("sha256").update(data).digest("hex");

export function r2Configured(): boolean {
  return Boolean(config.r2AccountId && config.r2AccessKey && config.r2SecretKey && config.r2Bucket && config.r2PublicBase);
}

export async function uploadToR2(filePath: string): Promise<string | null> {
  if (!r2Configured()) return null;
  const { r2AccountId, r2AccessKey, r2SecretKey, r2Bucket, r2PublicBase } = config;

  const body = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const key = `img/${crypto.createHash("md5").update(body).digest("hex")}${MIME[ext] ? ext : ".jpg"}`;
  const contentType = MIME[ext] ?? "image/jpeg";

  const host = `${r2AccountId}.r2.cloudflarestorage.com`;
  const uri = `/${r2Bucket}/${key}`;
  const payloadHash = sha256hex(body);

  // Mạng chập chờn (ECONNRESET/ETIMEDOUT khi 6 listing cùng upload) → thử lại.
  // Ký lại SigV4 mỗi lần vì chữ ký gắn với mốc thời gian, dùng lại chữ ký cũ sẽ bị từ chối.
  const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|network|aborted/i;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20260905T081500Z
    const day = now.slice(0, 8);

    // AWS SigV4 — region "auto", service "s3", signed headers cố định theo alphabet
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "PUT", uri, "",
      `content-type:${contentType}`, `host:${host}`,
      `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${now}`, "",
      signedHeaders, payloadHash,
    ].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", now, scope, sha256hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${r2SecretKey}`, day), "auto"), "s3"), "aws4_request");
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    try {
      await axios.put(`https://${host}${uri}`, body, {
        headers: {
          "Content-Type": contentType,
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": now,
          Authorization: `AWS4-HMAC-SHA256 Credential=${r2AccessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        timeout: 30000,
        maxBodyLength: Infinity,
      });
      const url = `${r2PublicBase}${uri.replace(`/${r2Bucket}`, "")}`;
      console.log(`☁️ R2: ${url}`);
      return url;
    } catch (e: any) {
      // e.message rỗng với vài lỗi socket → gộp nhiều nguồn để log không còn "undefined undefined".
      const why = e?.code || e?.response?.status || e?.message || e?.cause?.code || e?.constructor?.name || "loi la";
      const detail = String(e?.response?.data ?? "").slice(0, 200);
      const retriable = TRANSIENT.test(String(e?.code ?? "")) || TRANSIENT.test(String(e?.message ?? ""))
        || (typeof e?.response?.status === "number" && e.response.status >= 500);
      if (retriable && attempt < 3) {
        const wait = 700 * attempt + Math.floor(Math.random() * 400);
        console.warn(`⚠️ R2 upload lỗi (${why}) — thử lại ${attempt}/2 sau ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.warn(`⚠️ R2 upload lỗi (${why})${detail ? " " + detail : ""} — bỏ ảnh: ${path.basename(filePath)}`);
      return null;
    }
  }
  return null;
}
