/**
 * Inspect user records full (incl override fields).
 */
import { getDb } from "../state/db";

const db = getDb();
const rows = db.prepare(`
  SELECT username, role, auto_cron_override, headless_override
  FROM users ORDER BY username
`).all();
console.table(rows);
