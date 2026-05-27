/**
 * One-shot: import bất kỳ user nào còn trong admin-config.json mà chưa có trong DB.
 * Sau khi xong, rename file thành .migrated.
 */
import fs from "fs-extra";
import path from "path";
import { getDb } from "../state/db";

const main = async () => {
  const db = getDb();
  const legacy = path.resolve(process.cwd(), "data", "admin-config.json");

  if (!(await fs.pathExists(legacy))) {
    console.log("✓ admin-config.json không còn — đã migrate trước đó.");
    return;
  }

  const raw = await fs.readFile(legacy, "utf-8");
  const cfg = JSON.parse(raw);
  const users = cfg.users ?? [];

  const existing = db.prepare("SELECT username FROM users").all() as { username: string }[];
  const existingSet = new Set(existing.map((r) => r.username));

  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, role, profiles, download_dir, base_shein_auto_dir, api_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role          = excluded.role,
      profiles      = excluded.profiles,
      download_dir  = excluded.download_dir,
      base_shein_auto_dir = excluded.base_shein_auto_dir,
      api_token     = excluded.api_token,
      updated_at    = excluded.updated_at
  `);

  const now = Date.now();
  let imported = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const u of users) {
      if (existingSet.has(u.username)) {
        skipped++;
        console.log(`  ⏭️  ${u.username}: đã có trong DB`);
        continue;
      }
      insert.run(
        u.username,
        u.password ?? "",
        u.role ?? "viewer",
        JSON.stringify(u.profiles ?? []),
        u.downloadDir ?? "",
        u.baseSheinAutoDir ?? "",
        u.apiToken ?? "",
        now,
        now
      );
      imported++;
      console.log(`  ✓ ${u.username}: imported`);
    }
  });
  tx();

  console.log(`\n📥 Imported ${imported}, skipped ${skipped}.`);
  await fs.move(legacy, legacy + ".migrated", { overwrite: true });
  console.log(`📦 Renamed ${legacy} → ${legacy}.migrated`);
};

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
