// ایندکس ingest: آخرین پست‌های یک کانال باید بدون مرتب‌سازی موقت و بدون خواندن کل کانال پیدا شوند
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const schema = readFileSync(WORKER + "schema.sql", "utf8");
const raw = new DatabaseSync(":memory:");
raw.exec(schema);
raw.exec(schema); // اعمال دوباره نباید خطا بدهد (IF NOT EXISTS)
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT text FROM posts WHERE source = ? AND channel = ? ORDER BY id DESC LIMIT 400").all("bale", "x").map((r) => r.detail).join(" | ");
ok("ingest query uses posts_src_chan_id", plan.includes("posts_src_chan_id"));
ok("ingest query has no temp sort", !plan.includes("TEMP B-TREE"));
ok("schema applies twice without error", true);
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
