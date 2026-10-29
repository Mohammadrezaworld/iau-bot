// ایندکس‌های کوئری‌های پرخواندن: هیچ‌کدام نباید اسکن کامل جدول شوند
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const schema = readFileSync(WORKER + "schema.sql", "utf8");
const raw = new DatabaseSync(":memory:");
raw.exec(schema);
raw.exec(schema); // اعمال دوباره بدون خطا
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const plan = (sql, ...args) => raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((r) => r.detail).join(" | ");
const del = plan("DELETE FROM update_queue WHERE state = 'done' AND at_utc < ?", 1);
ok("DELETE done-updates uses update_queue_state_at", del.includes("update_queue_state_at") && !del.includes("SCAN"));
const mx = plan("SELECT MAX(ran_at_utc) AS t FROM scrape_runs WHERE source = ? AND ok = 1", "bale");
ok("sourceStatus MAX uses scrape_runs_source_ok", mx.includes("scrape_runs_source_ok") && !mx.includes("SCAN"));
const ex = plan("SELECT id FROM scrape_batches WHERE state = 'pending' AND expires_utc < ?", 1);
ok("expireBatches uses scrape_batches_state_expires", ex.includes("scrape_batches_state_expires") && !ex.includes("SCAN"));
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
