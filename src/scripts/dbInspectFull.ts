import { getDb } from "../state/db";
const rows = getDb().prepare(`
  SELECT username, role, profiles, base_shein_auto_dir, auto_cron_override, headless_override
  FROM users ORDER BY username
`).all();
console.table(rows);
