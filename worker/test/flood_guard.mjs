import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
const SRC = WORKER + "src";
const SECRET = "ingest_secret_for_test_123";
let nextId = 500;
const sent = [];
globalThis.fetch = async (url, opts) => {
  const m = String(url).split("/").pop();
  const b = opts && typeof opts.body === "string" ? JSON.parse(opts.body) : {};
  if (m === "sendMessage") sent.push({ chat: String(b.chat_id), text: String(b.text || "") });
  return { status: 200, json: async () => ({ ok: true, result: m === "sendMessage" ? { message_id: ++nextId } : true }) };
};
function freshEnv() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
  const wrap = (sql) => {
    const make = (args) => ({
      _sql: sql, _args: args,
      first: async () => raw.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: raw.prepare(sql).all(...args) }),
      run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    });
    return { ...make([]), bind: (...a) => make(a) };
  };
  raw.prepare("INSERT INTO settings (key, value) VALUES ('group_id', '-1001') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('bale_dry_run', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const batch = async (stmts) => {
    raw.exec("BEGIN");
    try {
      const out = stmts.map((st) => { const r = raw.prepare(st._sql).run(...st._args); return { meta: { changes: Number(r.changes) } }; });
      raw.exec("COMMIT"); return out;
    } catch (e) { raw.exec("ROLLBACK"); throw e; }
  };
  return { raw, env: { DB: { prepare: wrap, batch }, OWNER_ID: "900000001", TELEGRAM_BOT_TOKEN: "111111111:TEST_ONLY_NOT_A_REAL_TOKEN", INGEST_SECRET: SECRET, JOZVE_CHANNEL: "-100999" } };
}
const W = (await import(`${SRC}/index.js`)).default;
let failed = 0;
const check = (n, c, e = "") => { console.log((c ? "PASS" : "FAIL") + " - " + n + (e ? " | " + e : "")); if (!c) failed++; };
const ingest = (env, channel, posts) => W.fetch(new Request("https://w/ingest", {
  method: "POST",
  headers: { "content-type": "application/json", "x-ingest-secret": SECRET },
  body: JSON.stringify({ source: "bale", channel, posts }),
}), env);
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mk = (n, tag, date = TODAY) => Array.from({ length: n }, (_, i) => ({ post_id: `${tag}${i}`, text: `اطلاعیه ${tag} شماره ${i} برای دانشجویان`, image_url: "", post_date: date }));
const toGroup = () => sent.filter((s) => s.chat === "-1001" && s.text.includes("📰") || sent.filter((s) => s.chat === "-1001").length);

// پایه: یک اجرای قبلی تا اولین‌اجرا نباشه
{
  const { raw, env } = freshEnv();
  raw.prepare("INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok) VALUES ('bale','test_channel_c',1,0,1)").run();
  sent.length = 0;
  await ingest(env, "test_channel_c", mk(7, "a"));
  const groupMsgs = sent.filter((s) => s.chat === "-1001");
  const ownerMsgs = sent.filter((s) => s.chat === "900000001");
  check("flood (7 new bale posts): nothing sent to group", groupMsgs.length === 0, JSON.stringify(groupMsgs).slice(0, 120));
  check("flood: owner notified once", ownerMsgs.length === 1 && ownerMsgs[0].text.includes("به گروه نرفت"));
  const left = raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").get().n;
  check("flood: held posts marked sent (not queued forever)", left === 0, String(left));
  const floodMsg = ownerMsgs[0] ? ownerMsgs[0].text : "";
  check("flood: message makes no promise of manual resend", !floodMsg.includes("بگو تا دستی بفرستم") && floodMsg.includes("کنار گذاشته") && floodMsg.includes("ارسال مجدد ندارن"));
  check("flood: held posts recorded as held_flood (not delivered)", raw.prepare("SELECT COUNT(*) AS n FROM post_outcomes WHERE outcome = 'held_flood'").get().n === 7 && raw.prepare("SELECT COUNT(*) AS n FROM post_outcomes WHERE outcome = 'delivered'").get().n === 0);
  const ev = raw.prepare("SELECT detail FROM scrape_events WHERE kind = 'error'").get();
  check("flood: recorded in scrape_events", !!ev && ev.detail.includes("flood"));
}
// زیر سقف: ۳ پست جدید عادی می‌ره گروه
{
  const { raw, env } = freshEnv();
  raw.prepare("INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok) VALUES ('bale','test_channel_b',1,0,1)").run();
  sent.length = 0;
  await ingest(env, "test_channel_b", mk(3, "b"));
  const groupMsgs = sent.filter((s) => s.chat === "-1001");
  // طبق طراحی تأیید: پست‌ها مستقیم به گروه نمی‌رن؛ پیش‌نمایش دسته به مالک می‌ره
  check("3 new posts: nothing posted to group directly", groupMsgs.length === 0, JSON.stringify(groupMsgs).slice(0, 120));
  const ownerTexts = sent.filter((s) => s.chat === "900000001").map((s) => s.text);
  check("3 new posts: owner gets batch preview with the posts", ownerTexts.some((t) => t.includes("پیش‌نمایش")) && ownerTexts.some((t) => t.includes("اطلاعیه b شماره 0")), JSON.stringify(ownerTexts).slice(0, 160));
  check("3 new posts: no flood alert", !sent.some((s) => s.chat === "900000001" && s.text.includes("به گروه نرفت")));
  check("3 new posts: batch items created, nothing marked sent", raw.prepare("SELECT COUNT(*) AS n FROM scrape_batch_items").get().n === 3 && raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").get().n === 3);
}
// قدیمی (تاریخ گذشته) هرگز ارسال نمی‌شه، حتی وقتی تازه دیده شده
{
  const { raw, env } = freshEnv();
  raw.prepare("INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok) VALUES ('bale','test_channel_c',1,0,1)").run();
  sent.length = 0;
  await ingest(env, "test_channel_c", mk(3, "old", "2026-10-01"));
  check("old-dated posts: never sent to group", !sent.some((s) => s.chat === "-1001"));
  check("old-dated posts: stored as sent", raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").get().n === 0);
}
// بدون تاریخ: ارسال نمی‌شه
{
  const { raw, env } = freshEnv();
  raw.prepare("INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok) VALUES ('bale','test_channel_c',1,0,1)").run();
  sent.length = 0;
  await ingest(env, "test_channel_c", mk(2, "nodate", null));
  check("undated posts: not sent", !sent.some((s) => s.chat === "-1001"));
}
// حالت آزمایشی: هیچ‌چی به گروه نمی‌ره، گزارش به مالک می‌ره
{
  const { raw, env } = freshEnv();
  raw.prepare("UPDATE settings SET value = '1' WHERE key = 'bale_dry_run'").run();
  raw.prepare("INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok) VALUES ('bale','test_channel_c',1,0,1)").run();
  sent.length = 0;
  await ingest(env, "test_channel_c", [...mk(2, "dry"), ...mk(1, "dryold", "2026-10-01")]);
  check("dry run: nothing to group", !sent.some((s) => s.chat === "-1001"));
  const report = sent.find((s) => s.chat === "900000001");
  check("dry run: owner gets report with counts", !!report && report.text.includes("ارسال می‌شد: 2") && report.text.includes("قدیمی: 1"), report && report.text.slice(0, 120));
  check("dry run: all marked seen (queue empty)", raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").get().n === 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
