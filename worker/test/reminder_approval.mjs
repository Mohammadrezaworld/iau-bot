// یادآوری رویدادها: زمان‌بندی، تأیید مالک و جلوگیری از ارسال تکراری هم‌زمان.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { processReminders, handleReminderCallback, groupText } = await import(WORKER + "src/reminders.js");
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const e5Stub = { title: "تست", start_date: "2026-11-30" };
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const order = [];
let failReminderMarkOnce = false;
function statement(sql, args = []) {
  return {
    bind: (...a) => statement(sql, a),
    first: async () => { order.push({ m: "db:first", sql }); return raw.prepare(sql).get(...args) ?? null; },
    all: async () => { order.push({ m: "db:all", sql }); return { results: raw.prepare(sql).all(...args) }; },
    run: async () => {
      order.push({ m: "db:run", sql });
      if (failReminderMarkOnce && /INSERT OR IGNORE INTO reminder_log/.test(sql) && String(args[1] || "").startsWith("done:")) {
        failReminderMarkOnce = false;
        throw new Error("simulated reminder marker write failure");
      }
      const r = raw.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
  };
}
const db = { prepare: (sql) => statement(sql) };
const sent = []; const answers = []; const groupAttempts = [];
let groupSendMode = "ok"; // ok | refused400 | fail500
let groupGate = null;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  if (m === "answerCallbackQuery") { order.push({ m }); answers.push(b.text || ""); return Response.json({ ok: true, result: true }); }
  order.push({ m, chat_id: b.chat_id });
  if (m === "sendMessage" && String(b.chat_id) === "-100555") {
    groupAttempts.push({ ...b });
    if (groupSendMode === "refused400") return Response.json({ ok: false, error_code: 400, description: "chat not found" }, { status: 400 });
    if (groupSendMode === "fail500") return Response.json({ ok: false, error_code: 500, description: "temporary telegram failure" }, { status: 500 });
    const gate = groupGate;
    if (gate) { gate.started(); await gate.wait; }
  }
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

const addEvent = (title, start, kind) => raw.prepare("INSERT INTO events (title, start_date, end_date, kind, archived) VALUES (?, ?, ?, ?, 0)").run(title, start, start, kind) && raw.prepare("SELECT MAX(id) AS id FROM events").get().id;
const ids = {};
let nextTestUpdate = 50000;
const makeCtx = () => {
  const updateId = nextTestUpdate++;
  const lease = `test-lease-${updateId}`;
  raw.prepare("INSERT INTO update_queue (update_id,state,attempts,lease,payload,at_utc) VALUES (?,'processing',1,?,'{}',?)").run(updateId, lease, Math.floor(Date.now() / 1000));
  return { updateId, lease };
};
const cb = (uid, data) => ({ id: "c" + Math.random(), data, from: { id: uid }, message: { chat: { id: 5, type: "private" } } });
const groupMsgs = () => sent.filter((x) => String(x.chat_id) === "-100555");
const ownerMsgs = () => sent.filter((x) => String(x.chat_id) === "5");
const effect = (key) => raw.prepare("SELECT state, result, msg_id FROM effects WHERE op_key = ?").get(key) ?? null;

// رویداد قدیمی با کلیدهای قبلی (pre/day) که پیش‌تر ثبت شده
const e6 = addEvent("قدیمی", "2026-11-12", "امتحان");
raw.exec(`INSERT INTO reminder_log (event_id, kind) VALUES (${e6}, 'pre'), (${e6}, 'day')`);

// تهران: UTC+3:30
const tick = async (d, h, mi) => { Date.now = () => Date.UTC(...d, h - 3, mi - 30); sent.length = 0; await processReminders(env); return sent.filter((x) => x.m === "sendMessage" && String(x.chat_id) === "5"); };
const LABEL_KIND = { "۷ روز قبل": "pre7", "یک روز قبل": "pre1", "روز رویداد": "day", "فوری (تازه ثبت شده)": "now" };
const asked = []; // {title, kind, at}
const record = (at, msgs) => { for (const m of msgs) { const kind = Object.entries(LABEL_KIND).find(([l]) => m.text.includes(`(${l})`))?.[1]; const title = m.text.split("— ").pop().split("\n")[0]; asked.push({ title, kind, at }); } };
const Y = 2026, N = 10; // نوامبر = ماه ۱۰ در Date.UTC (صفرمایه)

ids.e1 = addEvent("عادی یک", "2026-11-10", "امتحان");
record("11-08 10:00", await tick([Y, N, 8], 10, 0));
record("11-09 19:59", await tick([Y, N, 9], 19, 59));
record("11-09 20:00", await tick([Y, N, 9], 20, 0));
record("11-09 20:01", await tick([Y, N, 9], 20, 1));
record("11-10 06:29", await tick([Y, N, 10], 6, 29));
record("11-10 06:30", await tick([Y, N, 10], 6, 30));
ids.e2 = addEvent("میان‌ترم دو", "2026-11-20", "میان‌ترم");
record("11-10 10:00", await tick([Y, N, 10], 10, 0));
record("11-13 20:00", await tick([Y, N, 13], 20, 0));
ids.e3 = addEvent("عادی دیر", "2026-11-15", "امتحان");
record("11-14 10:00", await tick([Y, N, 14], 10, 0));
record("11-14 20:00", await tick([Y, N, 14], 20, 0));
record("11-15 06:30", await tick([Y, N, 15], 6, 30));
record("11-19 20:00", await tick([Y, N, 19], 20, 0));
record("11-20 06:30", await tick([Y, N, 20], 6, 30));
ids.e4 = addEvent("میان‌ترم دیر", "2026-11-25", "میان‌ترم");
record("11-24 10:00", await tick([Y, N, 24], 10, 0));
record("11-25 06:30", await tick([Y, N, 25], 6, 30));
ids.e5 = addEvent("میان‌ترم سه روز", "2026-11-30", "میان‌ترم");
record("11-27 10:00", await tick([Y, N, 27], 10, 0));
record("11-29 20:00", await tick([Y, N, 29], 20, 0));
record("11-30 06:30", await tick([Y, N, 30], 6, 30));

const kindsOf = (t) => asked.filter((a) => a.title === t).map((a) => a.kind);
ok("normal event: asks day-before 20:00 and day-of 06:30 only", JSON.stringify(kindsOf("عادی یک")) === JSON.stringify(["pre1", "day"]) && asked.find((a) => a.title === "عادی یک" && a.kind === "pre1").at === "11-09 20:00" && asked.find((a) => a.title === "عادی یک" && a.kind === "day").at === "11-10 06:30");
ok("midterm: asks 7 days before, 1 day before, and day-of", JSON.stringify(kindsOf("میان‌ترم دو")) === JSON.stringify(["pre7", "pre1", "day"]));
ok("midterm day-of time is 06:30 (not 08:00)", asked.find((a) => a.title === "میان‌ترم دو" && a.kind === "day").at === "11-20 06:30");
ok("normal event registered in the day-before morning: one immediate ask only", JSON.stringify(kindsOf("عادی دیر")) === JSON.stringify(["now"]));
ok("midterm registered the day before (after 08:00): one immediate ask only", JSON.stringify(kindsOf("میان‌ترم دیر")) === JSON.stringify(["now"]));
ok("midterm registered 3 days before: 7-day reminder skipped, 1-day and day-of kept", JSON.stringify(kindsOf("میان‌ترم سه روز")) === JSON.stringify(["pre1", "day"]));
ok("legacy event: old pre/day logs are not asked again", kindsOf("قدیمی").length === 0);
ok("each reminder asked exactly once (no repeats)", new Set(asked.map((a) => a.title + a.kind)).size === asked.length);
ok("reminder text ends with the #یادآوری hashtag", groupText(e5Stub, "2026-11-30").endsWith("#یادآوری"));
ok("nothing sent to the group before owner approval", !sent.some((x) => String(x.chat_id) === "-100555"));

// تأیید مالک و marker قدیمی
sent.length = 0; answers.length = 0;
Date.now = () => Date.UTC(Y, N, 14, 10 - 3, 0 - 30);
await handleReminderCallback(env, cb(7, `rm2:s:${ids.e3}:now`));
ok("non-owner tap: nothing sent to the group", groupMsgs().length === 0);
order.length = 0;
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e3}:now`), makeCtx());
const reminderAckAt = order.findIndex((x) => x.m === "answerCallbackQuery");
const reminderReadAt = order.findIndex((x) => x.m === "db:first" && /reminder_log/.test(x.sql));
ok("owner approve: ack precedes D1 reads and group send; result remains visible", groupMsgs().length === 1 && groupMsgs()[0].text.includes("عادی دیر") && groupMsgs()[0].text.includes("فردا") && ownerMsgs().some((m) => m.text.includes("یادآوری به گروه ارسال شد")) && reminderAckAt >= 0 && reminderReadAt > reminderAckAt && order.findIndex((x) => String(x.chat_id) === "-100555") > reminderAckAt);
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e3}:now`), makeCtx());
ok("second tap on the same reminder: not sent again, result remains visible", groupMsgs().length === 1 && ownerMsgs().some((m) => m.text === "این یادآوری قبلاً جواب گرفته."));
await handleReminderCallback(env, cb(5, `rm2:r:${ids.e4}:now`), makeCtx());
ok("owner reject: nothing sent to the group and owner sees the result", groupMsgs().length === 1 && ownerMsgs().some((m) => m.text === "یادآوری ارسال نشد.") && effect(`reminder:${ids.e4}:now`)?.result === "rejected");

// بایگانی: دکمه‌ی قدیمی رویداد بایگانی‌شده، «دیگه فعال نیست» می‌گوید
raw.exec(`UPDATE events SET archived = 1 WHERE id = ${ids.e2}`);
sent.length = 0; answers.length = 0;
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e2}:pre1`));
ok("archived event button: says it is no longer active, nothing sent", ownerMsgs().some((m) => m.text === "این رویداد دیگه فعال نیست.") && groupMsgs().length === 0);

// تأیید و رد هم‌زمان از دو callback/update متفاوت: فقط تصمیم اول اجازه‌ی ارسال دارد.
const raceEvent = addEvent("رقابت تصمیم", "2026-11-30", "امتحان");
let startedResolve; let releaseResolve;
const started = new Promise((resolve) => { startedResolve = resolve; });
const release = new Promise((resolve) => { releaseResolve = resolve; });
groupGate = { started: startedResolve, wait: release };
const beforeRace = groupAttempts.length;
const approvePromise = handleReminderCallback(env, cb(5, `rm2:s:${raceEvent}:now`), makeCtx());
await started;
const rejectPromise = handleReminderCallback(env, cb(5, `rm2:r:${raceEvent}:now`), makeCtx());
await rejectPromise;
releaseResolve();
await approvePromise;
groupGate = null;
ok("concurrent approve/reject on distinct updates: one group send, other decision is busy", groupAttempts.length === beforeRace + 1 && groupAttempts.at(-1).text.includes("رقابت تصمیم") && ownerMsgs().some((m) => m.text.includes("در حال پردازشه")) && effect(`reminder:${raceEvent}:now`)?.result === "approved");

// اگر ارسال موفق شود ولی reminder_log نوشتنی نشود، effect=done جلوی ارسال بعدی را می‌گیرد و marker ترمیم می‌شود.
const repairEvent = addEvent("ترمیم marker", "2026-11-30", "امتحان");
const beforeRepair = groupAttempts.length;
failReminderMarkOnce = true;
let markerError = null;
try { await handleReminderCallback(env, cb(5, `rm2:s:${repairEvent}:now`), makeCtx()); } catch (err) { markerError = err; }
const repairKey = `reminder:${repairEvent}:now`;
const markerMissing = !raw.prepare("SELECT 1 FROM reminder_log WHERE event_id = ? AND kind = ?").get(repairEvent, "done:now");
await handleReminderCallback(env, cb(5, `rm2:s:${repairEvent}:now`), makeCtx());
ok("successful send with marker-write failure: no resend; retry repairs marker", !!markerError && effect(repairKey)?.state === "done" && markerMissing && groupAttempts.length === beforeRepair + 1 && !!raw.prepare("SELECT 1 FROM reminder_log WHERE event_id = ? AND kind = ?").get(repairEvent, "done:now"));

// رد صریح تلگرام (۴xx) قابل تلاش مجدد است؛ فقط رد صریح، نه نتیجه‌ی مبهم.
const refusalEvent = addEvent("رد تلگرام", "2026-11-30", "امتحان");
const beforeRefusal = groupAttempts.length;
groupSendMode = "refused400";
let refusedError = null;
try { await handleReminderCallback(env, cb(5, `rm2:s:${refusalEvent}:now`), makeCtx()); } catch (err) { refusedError = err; }
const refusedState = effect(`reminder:${refusalEvent}:now`)?.state;
groupSendMode = "ok";
await handleReminderCallback(env, cb(5, `rm2:s:${refusalEvent}:now`), makeCtx());
ok("explicit Telegram refusal is retryable and then succeeds once", refusedError?.refused === true && refusedState === "failed" && groupAttempts.length === beforeRefusal + 2 && effect(`reminder:${refusalEvent}:now`)?.state === "done");

// خطای 5xx: update به review می‌رود؛ کلیک دوم با شناسه‌ی متفاوت ارسال را تکرار نمی‌کند.
const ambiguousEvent = addEvent("ارسال نامشخص", "2026-11-30", "امتحان");
const ambiguousUpdate = 93001;
const ambiguousUpdateBody = (updateId) => ({ update_id: updateId, callback_query: { id: `amb-${updateId}`, from: { id: 5 }, data: `rm2:s:${ambiguousEvent}:now`, message: { message_id: 99, chat: { id: 5, type: "private" } } } });
const beforeAmbiguous = groupAttempts.length;
groupSendMode = "fail500";
const ambiguousResponse = await hook(ambiguousUpdateBody(ambiguousUpdate));
const ambiguousRow = raw.prepare("SELECT state, reason FROM update_queue WHERE update_id = ?").get(ambiguousUpdate);
const ambiguousEffect = effect(`reminder:${ambiguousEvent}:now`);
groupSendMode = "ok";
const secondResponse = await hook(ambiguousUpdateBody(93002));
ok("5xx send outcome: needs_review(intent); distinct callback does not auto-resend", ambiguousResponse.status === 200 && ambiguousRow?.state === "needs_review" && ambiguousRow?.reason === "ambiguous" && ambiguousEffect?.state === "intent" && secondResponse.status === 200 && groupAttempts.length === beforeAmbiguous + 1 && raw.prepare("SELECT state FROM update_queue WHERE update_id = 93002").get()?.state === "done" && ownerMsgs().some((m) => m.text.includes("در حال پردازشه")));

// دکمه‌ی یادآوری خارج از پیوی به هیچ اثر بیرونی نمی‌رسد.
const privateOnlyEvent = addEvent("فقط پیوی", "2026-11-30", "امتحان");
const beforePrivateOnly = groupAttempts.length;
await handleReminderCallback(env, { id: "group-rm2", data: `rm2:s:${privateOnlyEvent}:now`, from: { id: 5 }, message: { chat: { id: -100555, type: "supergroup" } } }, makeCtx());
ok("rm2 callback from a group is ignored", groupAttempts.length === beforePrivateOnly && !effect(`reminder:${privateOnlyEvent}:now`));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
