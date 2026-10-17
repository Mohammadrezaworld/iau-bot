// پشتیبان: هر جدول ماندگار schema باید در پشتیبان باشد یا با دلیل در فهرست «عمداً خارج» آمده باشد
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { BACKUP_TABLES, buildBackup } = await import(WORKER + "src/admin.js");

// جدول‌های موقت یا کش که عمداً در پشتیبان نیستند (هر کدام با دلیل)
const EXCLUDED = {
  update_queue: "صف موقت webhook",
  effects: "وضعیت اثر موقت؛ نتیجه‌ی ماندگار در posts/effects قابل بازسازی نیست و با صف پاک می‌شود",
  processed_updates: "شناسه‌ی موقت update",
  admin_sessions: "نشست موقت",
  user_cooldowns: "cooldown موقت",
  week_cache: "کش",
  metro_messages: "پیام‌های موقت منو",
  metro_usage: "شمارنده‌ی موقت",
  jozve_usage: "شمارنده‌ی موقت",
  pending_actions: "کارهای نیمه‌تمام موقت",
  undo_stack: "برگشت موقت",
  reminder_log: "لاگ موقت یادآوری",
  schema_migrations: "وضعیت مهاجرت، نه داده‌ی کاربر",
};

const schema = readFileSync(WORKER + "schema.sql", "utf8");
const raw = new DatabaseSync(":memory:");
raw.exec(schema);
const schemaTables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);

let fails = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

const uncovered = schemaTables.filter((t) => !BACKUP_TABLES.includes(t) && !(t in EXCLUDED));
ok("every schema table is backed up or explicitly excluded", uncovered.length === 0);
if (uncovered.length) console.log("  not covered:", uncovered.join(", "));
ok("no backup table missing from schema", BACKUP_TABLES.every((t) => schemaTables.includes(t)));
ok("excluded list has no backed-up table", Object.keys(EXCLUDED).every((t) => !BACKUP_TABLES.includes(t)));

const db = { prepare(sql) { const st = raw.prepare(sql); return { all: async () => ({ results: st.all() }) }; } };
const out = await buildBackup({ DB: db });
ok("buildBackup returns every backup table", BACKUP_TABLES.every((t) => Array.isArray(out[t])));
ok("buildBackup includes posts and batch decisions", ["posts", "post_outcomes", "scrape_batches", "scrape_batch_items"].every((t) => t in out));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED");
process.exit(fails ? 1 : 0);
