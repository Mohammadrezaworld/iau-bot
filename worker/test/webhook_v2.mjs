import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
// تست صف و اثرها روی SQLite واقعی (فایل SQLite موقت؛ production دست‌نخورده).
// کد واقعی worker اجرا می‌شه؛ فقط تلگرام (fetch) و خطای DB شبیه‌سازی شده.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, existsSync } from "fs";
const DBFILE = process.env.QTEST_DB;
if (!DBFILE) throw new Error("QTEST_DB required");
if (existsSync(DBFILE)) rmSync(DBFILE);
const SCHEMA = readFileSync(WORKER + "schema.sql", "utf8");

// 1) وضعیت قدیمی prod: فقط processed_updates با سه حالت
const raw = new DatabaseSync(DBFILE);
raw.exec(`CREATE TABLE processed_updates (update_id INTEGER PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, at_utc INTEGER NOT NULL);
INSERT INTO processed_updates VALUES (2001,'done',1,1791966000),(2002,'failed',1,1791966000),(2003,'processing',2,1791966000);`);
raw.exec(SCHEMA);

const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret, tg, acknowledgeCallbackEarly, answerCallback } = await import(WORKER + "src/telegram.js");
const { claimUpdate, markOutcome } = await import(WORKER + "src/updates.js");
const { claimExternal, finishExternal, dbEffect, LeaseLostError } = await import(WORKER + "src/effects.js");
const { handleJozveCallback } = await import(WORKER + "src/jozve.js");

let failDb = null; // تابع sql → true یعنی این دستور خطا بده
let trace = null;
const chk = (sql) => { if (failDb && failDb(sql)) throw new Error("db unavailable"); };
function mk(sql, args = []) {
  const o = {
    _sql: sql, _args: args,
    bind: (...a) => mk(sql, a),
    first: async () => { chk(sql); trace && trace.push(`db:first:${sql}|${JSON.stringify(args)}`); return raw.prepare(sql).get(...args) ?? null; },
    all: async () => { chk(sql); trace && trace.push(`db:all:${sql}|${JSON.stringify(args)}`); return { results: raw.prepare(sql).all(...args) }; },
    run: async () => runSync(o),
  };
  return o;
}
function runSync(o) { chk(o._sql); trace && trace.push(`db:run:${o._sql}|${JSON.stringify(o._args)}`); const r = raw.prepare(o._sql).run(...o._args); return { meta: { changes: Number(r.changes) } }; }
const db = {
  prepare: (sql) => mk(sql),
  // batch = تراکنش واقعی: همه یا هیچ
  batch: async (stmts) => {
    raw.exec("BEGIN");
    try { const out = stmts.map(runSync); raw.exec("COMMIT"); return out; }
    catch (e) { raw.exec("ROLLBACK"); throw e; }
  },
};

// ---- تلگرام شبیه‌سازی‌شده
const ok = (result) => Response.json({ ok: true, result });
let mid = 900;
const sent = []; const copies = []; const calls = [];
const rules = { copy: "ok", failChat: {} }; // copy: ok | refuse | network · failChat[chat] = تعداد خطای شبکه باقی‌مانده
globalThis.fetch = async (u, o) => {
  const method = String(u).split("/").pop();
  const b = o && o.body ? JSON.parse(o.body) : {};
  calls.push(method);
  trace && trace.push(`tg:${method}`);
  if (method === "getChatMember") return ok({ status: "member" });
  if (method === "copyMessage") {
    if (rules.copy === "refuse") return Response.json({ ok: false, error_code: 400, description: "message not found" }, { status: 400 });
    if (rules.copy === "network") throw new Error("socket hang up");
    copies.push(b); return ok({ message_id: ++mid });
  }
  const left = rules.failChat[String(b.chat_id)];
  if (left > 0) { rules.failChat[String(b.chat_id)] = left - 1; throw new Error("network down"); }
  if (method === "sendMessage") sent.push(b);
  return ok({ message_id: ++mid });
};

const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-1004434418889", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
const NOW = 1791966600;
globalThis.Date.now = () => NOW * 1000;

let fails = 0;
const ok_ = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const q1 = (sql, ...a) => raw.prepare(sql).get(...a);
const qAll = (sql, ...a) => raw.prepare(sql).all(...a);
const row = (id) => q1("SELECT state, attempts, lease, reason, notify_state FROM update_queue WHERE update_id = ?", id);
const eff = (op) => q1("SELECT state, msg_id, update_id, lease FROM effects WHERE op_key = ?", op);
const dm = (id, text = "/start", uid = 77) => ({ update_id: id, message: { message_id: id, chat: { id: uid, type: "private" }, from: { id: uid }, text } });
const ownerMsg = (id, text) => dm(id, text, 5);
const cbq = (id, data, uid, chat = -100555) => ({ update_id: id, callback_query: { id: "cb" + id, from: { id: uid }, data, message: { message_id: 50 + (id % 1000), chat: { id: chat, type: "supergroup" } } } });
const sentTo = (chat) => sent.filter((m) => String(m.chat_id) === String(chat));
const reset = () => { sent.length = 0; copies.length = 0; calls.length = 0; };

// ---------- الف) مهاجرت ----------
ok_("M1 migration: done stays done", row(2001)?.state === "done");
ok_("M1 migration: failed/processing -> needs_review(migrated), no payload", row(2002).state === "needs_review" && row(2002).reason === "migrated" && row(2003).state === "needs_review");
ok_("M1 schema_migrations recorded once", q1("SELECT COUNT(*) AS n FROM schema_migrations").n === 1);
raw.exec("UPDATE update_queue SET state='failed' WHERE update_id=2002");
raw.exec(SCHEMA); // اجرای دوباره‌ی schema (هر deploy)
ok_("M2 re-applying schema does not re-migrate or overwrite state", row(2002).state === "failed" && q1("SELECT COUNT(*) AS n FROM schema_migrations").n === 1);
reset(); let r = await hook(dm(2001));
ok_("M3 migrated done update is NOT re-run after migration", r.status === 200 && sentTo(77).length === 0);
reset(); r = await hook(dm(2003));
ok_("M4 migrated needs_review update is not auto-run (owner review)", r.status === 200 && sentTo(77).length === 0 && row(2003).state === "needs_review");

// ---------- ب) پوشش رفتاری قبلی (webhook_idem_test) ----------
reset(); r = await hook(dm(1001));
ok_("B1 normal update: 200, done, side effect once", r.status === 200 && row(1001).state === "done" && sentTo(77).length === 1);
reset(); r = await hook(dm(1001));
ok_("B2 duplicate of done: no repeated side effect", r.status === 200 && sentTo(77).length === 0);
rules.failChat["77"] = 1; reset();
r = await hook(dm(1002));
ok_("B3 first failure: 500, failed, attempts=1", r.status === 500 && row(1002).state === "failed" && row(1002).attempts === 1);
reset(); r = await hook(dm(1002));
ok_("B3 retry succeeds: done, attempts=2", r.status === 200 && row(1002).state === "done" && row(1002).attempts === 2 && sentTo(77).length === 1);
raw.exec(`INSERT INTO update_queue (update_id,state,attempts,lease,payload,at_utc) VALUES (1004,'processing',1,'LIVE','${JSON.stringify(dm(1004))}',${NOW})`);
reset(); r = await hook(dm(1004));
ok_("B4 fresh processing: 500 busy, attempts unchanged", r.status === 500 && row(1004).attempts === 1 && sentTo(77).length === 0);
raw.exec(`UPDATE update_queue SET at_utc=${NOW - 600}, lease='OLD' WHERE update_id=1004`);
const runB = await claimUpdate(env, 1004, "{}");
ok_("B5 stale processing reclaimed; attempts=2; new lease", runB.status === "claimed" && runB.attempts === 2);
ok_("B5 old run cannot write done", (await markOutcome(env, 1004, "OLD", "done")) === false && row(1004).state === "processing");
ok_("B5 current run writes done", (await markOutcome(env, 1004, runB.lease, "done")) === true && row(1004).state === "done");
// exhaustion
rules.failChat["78"] = 2;
reset(); r = await hook(dm(1005, "/start", 78));
ok_("B6 attempt 1 fails: 500", r.status === 500 && row(1005).state === "failed");
reset(); r = await hook(dm(1005, "/start", 78));
ok_("B6 attempt 2 (last) fails: 200, needs_review(exhausted), owner notified without user text",
  r.status === 200 && row(1005).state === "needs_review" && row(1005).reason === "exhausted" &&
  sentTo(5).some((m) => m.text.includes("/review") && m.text.includes("exhausted") || m.text.includes("علت: exhausted")));
reset(); r = await hook(dm(1005, "/start", 78));
ok_("B6 redelivery of needs_review: 200, no processing", r.status === 200 && sentTo(78).length === 0);

// ---------- ج) انتشار جزوه: claim با lease ----------
const cfg = q1("SELECT 1 FROM settings WHERE key = 'group_id'");
raw.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('group_id', '-100555')");
raw.exec("INSERT INTO jozve_files (course, professor, title, file_name, file_size, channel_msg_id, created_utc) VALUES ('ریاضی', 'دکتر الف', '', 'a.pdf', 1, 10, 1), ('ریاضی', 'دکتر ب', '', 'b.pdf', 1, 11, 1), ('ریاضی', 'دکتر ج', '', 'c.pdf', 1, 12, 1), ('ریاضی', 'دکتر د', '', 'd.pdf', 1, 13, 1), ('ریاضی', 'دکتر ه', '', 'e.pdf', 1, 14, 1)");

// C1: خطای شبکه → ambiguous → needs_review؛ retry کور انجام نمی‌شه
rules.copy = "network"; reset();
r = await hook(cbq(3001, "j:f:ریاضی|دکتر الف", 81));
ok_("C1 network error on copy: needs_review(ambiguous), no retry, no copy", r.status === 200 && row(3001).state === "needs_review" && row(3001).reason === "ambiguous" && copies.length === 0);
ok_("C1 ambiguous result remains visible after the early callback ack", calls[0] === "answerCallbackQuery" && sentTo(-100555).some((m) => m.text.includes("بعضی فایل‌ها نیاز به بررسی دارن")));
ok_("C1 effect is intent (unknown outcome)", eff("publish:-100555:ریاضی|دکتر الف|a.pdf")?.state === "intent");
rules.copy = "ok"; reset();
r = await hook({ update_id: 3002, message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, text: "/retry_update 3001" } });
ok_("C1 retry refused while outcome is unknown", sentTo(5).some((m) => m.text.includes("اثر نامشخص")) && row(3001).state === "needs_review" && copies.length === 0);
reset(); await hook(ownerMsg(3003, "/resolve_update 3001 not_applied"));
ok_("C1 owner: not_applied -> effect failed, update failed(retryable)", eff("publish:-100555:ریاضی|دکتر الف|a.pdf").state === "failed" && row(3001).state === "failed");
reset(); await hook(ownerMsg(3004, "/retry_update 3001"));
ok_("C1 retry after owner decision copies exactly once", copies.length === 1 && row(3001).state === "done" && eff("publish:-100555:ریاضی|دکتر الف|a.pdf").state === "done");

// C2: applied → done، بدون کپی
rules.copy = "network"; reset();
await hook(cbq(3101, "j:f:ریاضی|دکتر ب", 82));
rules.copy = "ok"; reset();
await hook(ownerMsg(3102, "/resolve_update 3101 applied"));
ok_("C2 owner applied: update done, no copy", row(3101).state === "done" && copies.length === 0 && eff("publish:-100555:ریاضی|دکتر ب|b.pdf").state === "done");

// C3: تأیید هم‌زمان دو کاربر → فقط یک کپی
reset();
const par = await Promise.all([hook(cbq(3201, "j:f:ریاضی|دکتر ج", 83)), hook(cbq(3202, "j:f:ریاضی|دکتر ج", 84))]);
ok_("C3 two concurrent confirmations: exactly one copy", copies.length === 1);
ok_("C3 concurrent: both answered 200, no duplicate effect row", par.every((x) => x.status === 200) && q1("SELECT COUNT(*) AS n FROM effects WHERE op_key LIKE 'publish:-100555:ریاضی|دکتر ج%'").n === 1);

// C4: lease قدیمی نمی‌تونه ارسال تازه انجام بده
raw.exec(`INSERT INTO update_queue (update_id,state,attempts,lease,payload,at_utc) VALUES (3301,'processing',1,'LIVE',NULL,${NOW})`);
reset(); let thrown = null;
try { await handleJozveCallback(env, { id: "x", from: { id: 85 }, data: "j:f:ریاضی|دکتر د", message: { message_id: 1, chat: { id: -100555, type: "supergroup" } } }, { updateId: 3301, lease: "OLD" }); }
catch (e) { thrown = e; }
ok_("C4 stale run after lease loss: LeaseLostError and no copy", thrown instanceof LeaseLostError && copies.length === 0 && !eff("publish:-100555:ریاضی|دکتر د|d.pdf"));

// C5: refused → failed، تلاش بعدی مجاز
rules.copy = "refuse"; reset();
r = await hook(cbq(3401, "j:f:ریاضی|دکتر ه", 86));
ok_("C5 refused copy: effect failed (not unknown), update completes", r.status === 200 && eff("publish:-100555:ریاضی|دکتر ه|e.pdf").state === "failed" && row(3401).state === "done");
rules.copy = "ok"; reset();
r = await hook(cbq(3402, "j:f:ریاضی|دکتر ه", 87));
ok_("C5 later confirmation copies once and marks done", copies.length === 1 && eff("publish:-100555:ریاضی|دکتر ه|e.pdf").state === "done");

// C6: spinner بلافاصله بسته می‌شود، پیش از ویرایش منوی جزوه
reset();
trace = [];
r = await hook(cbq(3455, "j:b", 88));
const jozveAckAt = trace.indexOf("tg:answerCallbackQuery");
const groupLookupAts = trace.reduce((a, x, i) => { if (x === 'db:first:SELECT value FROM settings WHERE key = ?|["group_id"]') a.push(i); return a; }, []);
ok_("C6 jozve callback acknowledges after quiet-hours guard, before dispatch lookup/edit", r.status === 200 && calls[0] === "answerCallbackQuery" && calls.includes("editMessageText") && groupLookupAts.length >= 2 && groupLookupAts[0] < jozveAckAt && jozveAckAt < groupLookupAts[1]);
trace = null;

// C6b: callback خصوصی پیش از اولین claim صف جواب داده می‌شود.
reset(); trace = [];
r = await hook({ update_id: 3459, callback_query: { id: "private-first-db", from: { id: 5 }, data: "kw:n", message: { message_id: 59, chat: { id: 5, type: "private" } } } });
const privateAckAt = trace.indexOf("tg:answerCallbackQuery");
const queueClaimAt = trace.findIndex((x) => x.startsWith("db:run:INSERT OR IGNORE INTO update_queue"));
ok_("C6b private callback acknowledges before update_queue D1 claim", r.status === 200 && privateAckAt >= 0 && queueClaimAt > privateAckAt);
trace = null;

// C7: منوی ادمین، ack پیش از اجرای دستور و پاسخ راهنما باقی می‌ماند.
reset();
r = await hook({ update_id: 3456, callback_query: { id: "admin-menu-ack-test", from: { id: 5 }, data: "am:19", message: { message_id: 51, chat: { id: 5, type: "private" } } } });
ok_("C7 admin menu acknowledges before command and keeps its reply", r.status === 200 && calls[0] === "answerCallbackQuery" && sentTo(5).some((m) => m.text.includes("دستورهای ادمین")));

// C8/C9: status refresh/edit و close/delete هم spinner را پیش از تماس تلگرام می‌بندند.
reset();
r = await hook({ update_id: 3457, callback_query: { id: "status-refresh-ack-test", from: { id: 5 }, data: "st:r", message: { message_id: 52, chat: { id: 5, type: "private" }, text: "وضعیت" } } });
ok_("C8 status refresh acknowledges before editing status", r.status === 200 && calls[0] === "answerCallbackQuery" && calls.includes("editMessageText"));
reset();
r = await hook({ update_id: 3458, callback_query: { id: "close-list-ack-test", from: { id: 5 }, data: "x:c", message: { message_id: 53, chat: { id: 5, type: "private" } } } });
ok_("C9 close-list callback acknowledges before deleting message", r.status === 200 && calls[0] === "answerCallbackQuery" && calls.includes("deleteMessage"));

// ---------- د) ثبت DB با کلید پایدار ----------
// D1: خطای ارسال تأیید بعد از ثبت → retry ردیف دوم نمی‌سازه
reset(); rules.failChat["5"] = 1;
r = await hook(ownerMsg(4001, "/call_add دانشجو | علی | 0912 | یادداشت"));
const nBefore = q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'علی'").n;
ok_("D1 first attempt: contact inserted, reply failed -> 500 retry", r.status === 500 && nBefore === 1 && row(4001).state === "failed");
// D1-ب: شناسه‌ی ردیف ثبت شده و نمایش آن در /review
const contactId = q1("SELECT id FROM contacts WHERE name = 'علی'").id;
ok_("D1 effect records the DB row id for manual inspection", q1("SELECT row_id FROM effects WHERE op_key = 'msg:5:4001:call_add'").row_id === contactId);
raw.exec(`UPDATE update_queue SET at_utc=${NOW - 700} WHERE update_id=4001`);
reset(); await hook(ownerMsg(4002, "/review"));
ok_("D1 /review shows row id and key for the update", sentTo(5).some((m) => m.text.includes(`ردیف DB #${contactId}`) && m.text.includes("کلید msg:5:4001:call_add")));

reset(); r = await hook(ownerMsg(4001, "/call_add دانشجو | علی | 0912 | یادداشت"));
ok_("D1 retry: no second contact row; reply says already saved", r.status === 200 && q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'علی'").n === 1 && sentTo(5).some((m) => m.text.includes("قبلاً")));

// D2: دو درخواست هم‌نام اما جدا (دو پیام متفاوت) → دو رویداد معتبر
reset();
await hook(ownerMsg(4101, "/event_add ۱۴۰۵-۰۷-۲۸ | | میان‌ترم | امتحان"));
await hook(ownerMsg(4102, "/event_add ۱۴۰۵-۰۷-۲۸ | | میان‌ترم | امتحان"));
ok_("D2 two separate same-name events are both kept", q1("SELECT COUNT(*) AS n FROM events WHERE title = 'میان‌ترم'").n === 2);

// D3: batch همزمان با کلید یکسان → یک ردیف
const stmt = { table: "resources", cols: ["category", "title", "url", "note"], vals: ["c", "t", "https://a", ""] };
const res = await Promise.all([1, 2, 3, 4, 5].map(() => dbEffect(env, "wizard:9:link:1:x", "resources", stmt, "link")));
ok_(`D3 five concurrent dbEffect same key: one row (created=${res.filter((x) => x.created).length})`, res.filter((x) => x.created).length === 1 && q1("SELECT COUNT(*) AS n FROM resources WHERE title = 't'").n === 1);

// D4: خطای DB وسط batch → هیچ‌کدوم ثبت نمی‌شه (تراکنش)
failDb = (sql) => /UPDATE effects SET state = 'done'/.test(sql);
let batchErr = null;
try { await dbEffect(env, "wizard:9:link:2:y", "resources", { table: "resources", cols: ["category", "title", "url", "note"], vals: ["c", "rollback-me", "https://b", ""] }, "x"); } catch (e) { batchErr = e; }
failDb = null;
ok_("D4 db failure mid-batch: rolled back (no row, no effect)", batchErr && q1("SELECT COUNT(*) AS n FROM resources WHERE title = 'rollback-me'").n === 0 && !eff("wizard:9:link:2:y"));

// ---------- ه) خطای ثبت done و فهرست مالک ----------
failDb = (sql) => /SET state = 'done', payload = NULL/.test(sql);
reset(); r = await hook(dm(5001, "/start", 90));
failDb = null;
ok_("E1 done-write fails after success: 200, row stays processing, effect ran once", r.status === 200 && row(5001).state === "processing" && sentTo(90).length === 1);
raw.exec(`UPDATE update_queue SET at_utc=${NOW - 700} WHERE update_id=5001`);
reset(); await hook(ownerMsg(5002, "/review"));
ok_("E1 owner /review lists the stuck update (نتیجه نامشخص)", sentTo(5).some((m) => m.text.includes("#5001") && m.text.includes("پردازش مانده")));
reset(); await hook(ownerMsg(5003, "/retry_update 5001"));
ok_("E1 owner retry: done (no unknown effect), replay allowed", row(5001).state === "done");

// ---------- و) اطلاع به مالک شکست خورده قابل دیدن است ----------
rules.failChat["91"] = 2; rules.failChat["5"] = 1;
reset(); await hook(dm(6001, "/start", 91)); await hook(dm(6001, "/start", 91));
ok_("F1 owner notification failed: notify_state=failed", row(6001).state === "needs_review" && row(6001).notify_state === "failed");
reset(); await hook(ownerMsg(6002, "/review"));
ok_("F1 /review shows the item and that notification did not arrive", sentTo(5).some((m) => m.text.includes("#6001") && m.text.includes("اطلاع خودکار نرسید")));
ok_("F1 /review has buttons for owner decisions", (sentTo(5).at(-1).reply_markup?.inline_keyboard?.[0]?.length ?? 0) === 3);

// ---------- ز) فقط مالک ----------
reset(); await hook(dm(6101, "/review", 77));
ok_("G1 non-owner /review: silent", sentTo(5).length === 0 && sentTo(77).length === 0);
reset(); await hook(dm(6102, "/retry_update 1005", 77));
ok_("G2 non-owner /retry_update: silent, no state change", sentTo(77).length === 0 && row(1005).state === "needs_review");

// ---------- ح) retry هم‌زمان مالک: یک اجرا ----------
raw.exec(`INSERT INTO update_queue (update_id,state,attempts,lease,payload,at_utc,reason) VALUES (7001,'needs_review',2,'','${JSON.stringify(dm(7001, "/start", 95))}',${NOW - 900},'exhausted')`);
reset();
await Promise.all([hook(ownerMsg(7101, "/retry_update 7001")), hook(ownerMsg(7102, "/retry_update 7001"))]);
ok_("H1 two concurrent owner retries: dispatched once", sentTo(95).length === 1 && row(7001).state === "done");

// ---------- ط) claim هم‌زمان ----------
raw.exec(`INSERT INTO update_queue (update_id,state,attempts,lease,payload,at_utc) VALUES (8001,'failed',1,'','{}',${NOW - 5})`);
const claims = await Promise.all([1, 2, 3, 4].map(() => claimUpdate(env, 8001, "{}")));
ok_("I1 four concurrent claims on failed row: one winner", claims.filter((c) => c.status === "claimed").length === 1 && row(8001).attempts === 2);

// ---------- ی) ویزارد: شناسه‌ی جلسه ----------
const runWizard = async (startId, uid, texts) => {
  await hook(dm(startId, "/call_add", uid));
  for (let i = 0; i < texts.length; i++) await hook(dm(startId + 1 + i, texts[i], uid));
};
const wOk = (id, uid) => ({ update_id: id, callback_query: { id: "wcb" + id, from: { id: uid }, data: "w:ok", message: { message_id: id, chat: { id: uid, type: "private" } } } });
const SEQ = ["دسته تست", "شخص مشابه", "0912111", "یادداشت"];
// W1: دو جلسه‌ی مستقل با داده‌ی یکسان → دو ردیف، کلید متفاوت
await runWizard(9101, 5, SEQ);
const sid1 = JSON.parse(q1("SELECT data FROM admin_sessions WHERE user_id = 5").data)._sid;
reset(); let w = await hook(wOk(9110, 5));
await runWizard(9120, 5, SEQ);
const sid2 = JSON.parse(q1("SELECT data FROM admin_sessions WHERE user_id = 5").data)._sid;
w = await hook(wOk(9130, 5));
ok_("W1 two independent sessions, identical data: two rows", q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'شخص مشابه'").n === 2);
ok_("W1 session ids differ and are unique", sid1 && sid2 && sid1 !== sid2);
// W2: retry همان جلسه (پاک‌کردن جلسه شکست خورده) → همون کلید، ردیف دوم نیست
await runWizard(9140, 5, ["دسته W2", "شخص W2", "0912222", "-"]);
failDb = (sql) => /DELETE FROM admin_sessions/.test(sql);
const wUpd = wOk(9150, 5);
w = await hook(wUpd);
failDb = null;
ok_("W2 clear-session failure after insert: 500, row inserted once", w.status === 500 && q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'شخص W2'").n === 1);
w = await hook(wUpd);
ok_("W2 retry of same session: no second row, session cleared", w.status === 200 && q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'شخص W2'").n === 1 && !q1("SELECT 1 AS x FROM admin_sessions WHERE user_id = 5"));
// W3: جلسه‌ی قدیمی بدون شناسه ثبت نمی‌شه
raw.exec(`INSERT INTO admin_sessions (user_id, flow, step, data, updated_utc) VALUES (5, 'call', 4, '${JSON.stringify({ category: "قدیمی", name: "legacy", number: "0912333", note: "" })}', 1)`);
reset(); w = await hook(wOk(9160, 5));
ok_("W3 legacy session without id: nothing inserted, asks to restart", q1("SELECT COUNT(*) AS n FROM contacts WHERE name = 'legacy'").n === 0 && sentTo(5).some((m) => m.text.includes("دوباره از اول")));

// A6: اثر ویزارد به update تأیید وصل است تا /review جزئیاتش را نشان دهد
await runWizard(9170, 5, ["دسته A6", "شخص A6", "0912666", "-"]);
const sidA6 = JSON.parse(q1("SELECT data FROM admin_sessions WHERE user_id = 5").data)._sid;
rules.failChat["5"] = 1;
reset(); w = await hook(wOk(9180, 5));
const a6Effect = q1("SELECT state, update_id, row_id FROM effects WHERE op_key = ?", `wizard:5:call:${sidA6}`);
ok_("A6 wizard effect records its callback update id after reply failure", w.status === 500 && row(9180).state === "failed" && a6Effect?.state === "done" && a6Effect.update_id === 9180);
raw.exec(`UPDATE update_queue SET at_utc=${NOW - 700} WHERE update_id=9180`);
reset(); await hook(ownerMsg(9181, "/review"));
const reviewA6 = sentTo(5).at(-1)?.text || "";
ok_("A6 /review shows wizard effect row id and key", reviewA6.includes(`ردیف DB #${a6Effect.row_id}`) && reviewA6.includes(`کلید wizard:5:call:${sidA6}`));

// T1: پاسخ callback برای یک query تکراری دوباره به Telegram فرستاده نمی‌شود.
reset();
await tg(env, "answerCallbackQuery", { callback_query_id: "ack-cache-test" });
await tg(env, "answerCallbackQuery", { callback_query_id: "ack-cache-test" });
ok_("T1 duplicate answerCallbackQuery is deduplicated", calls.filter((m) => m === "answerCallbackQuery").length === 1);

// T2: فقط خطای صریح 400 برای query منقضی/نامعتبر بی‌اثر می‌شود.
const savedFetch = globalThis.fetch;
let staleAckCalls = 0;
globalThis.fetch = async () => {
  staleAckCalls++;
  return Response.json({ ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" }, { status: 400 });
};
const staleAckResult = await tg(env, "answerCallbackQuery", { callback_query_id: "stale-ack-test" });
globalThis.fetch = savedFetch;
ok_("T2 explicit stale callback 400 is swallowed without retry", staleAckResult === null && staleAckCalls === 1);

let otherAckError = null;
globalThis.fetch = async () => Response.json({ ok: false, error_code: 400, description: "Bad Request: unrelated callback failure" }, { status: 400 });
try { await tg(env, "answerCallbackQuery", { callback_query_id: "other-ack-error-test" }); }
catch (err) { otherAckError = err; }
globalThis.fetch = savedFetch;
ok_("T3 unrelated callback 400 still fails explicitly", otherAckError?.refused === true && /unrelated callback failure/.test(otherAckError.message));

// T4: toast متن‌دار بعد از ACK زودهنگام به پیام قابل‌دیدن تبدیل می‌شود و تکرار نمی‌شود.
reset();
const feedbackCb = { id: "ack-feedback-fallback", message: { message_id: 900, chat: { id: 5, type: "private" } } };
await acknowledgeCallbackEarly(env, feedbackCb);
await answerCallback(env, feedbackCb, "بازخورد قابل‌دیدن", true);
await answerCallback(env, feedbackCb, "بازخورد قابل‌دیدن", true);
ok_("T4 text feedback survives an early ack and is sent only once", calls.filter((m) => m === "answerCallbackQuery").length === 1 && sentTo(5).filter((m) => m.text === "بازخورد قابل‌دیدن").length === 1);

// T5: failed visible feedback after ACK must not fail/replay the already-acknowledged callback action.
const failedFeedbackCb = { id: "ack-feedback-failure", message: { message_id: 901, chat: { id: 5, type: "private" } } };
const originalFetch = globalThis.fetch; let failedNoticeCalls = 0;
globalThis.fetch = async (u) => {
  if (String(u).endsWith("/answerCallbackQuery")) return Response.json({ ok: true, result: true });
  failedNoticeCalls++;
  return Response.json({ ok: false, error_code: 500, description: "temporary notice failure" }, { status: 500 });
};
await acknowledgeCallbackEarly(env, failedFeedbackCb);
let feedbackError = null;
try { await answerCallback(env, failedFeedbackCb, "بازخورد موقت"); } catch (err) { feedbackError = err; }
await answerCallback(env, failedFeedbackCb, "بازخورد موقت");
globalThis.fetch = originalFetch;
ok_("T5 failed visible feedback is swallowed and not retried", feedbackError === null && failedNoticeCalls === 1);

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
