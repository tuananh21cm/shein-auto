/**
 * Quick inspect SQLite content.
 */
import { getDb } from "../state/db";

const main = () => {
  const db = getDb();
  const users = db.prepare("SELECT username, role, api_token FROM users").all();
  const history = db.prepare("SELECT COUNT(*) as c FROM history").get();
  const cache = db.prepare("SELECT kind, COUNT(*) as c FROM gemini_cache GROUP BY kind").all();
  console.log("== USERS ==");
  console.table(users);
  console.log("== HISTORY ==", history);
  console.log("== GEMINI CACHE ==");
  console.table(cache);
  console.log("== SCHEMA VERSION ==", db.pragma("user_version", { simple: true }));
};

main();
