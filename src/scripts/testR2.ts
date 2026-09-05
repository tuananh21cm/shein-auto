// Self-check: upload 1 ảnh PNG thật lên R2 rồi verify URL public serve được.
// Chạy: npx tsx src/scripts/testR2.ts
import fs from "fs";
import path from "path";
import assert from "assert";
import { uploadToR2 } from "../utils/uploadToR2";
import { verifyImageUrl } from "../utils/uploadToImgbb";

(async () => {
  // PNG 1x1 đỏ hợp lệ
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const tmp = path.join(process.cwd(), "data", "_r2_test.png");
  fs.writeFileSync(tmp, png);

  const url = await uploadToR2(tmp);
  assert(url, "uploadToR2 trả null — check creds/bucket");
  assert(url!.startsWith("https://pub-"), `URL lạ: ${url}`);
  const alive = await verifyImageUrl(url!);
  assert(alive, `URL không serve được: ${url}`);
  console.log("✅ R2 OK:", url);
  fs.unlinkSync(tmp);
})();
