// یادآوری رویداد: پرسش از مالک (نه ارسال مستقیم)، زمان‌های جدید (۰۶:۳۰ و ۷ روز قبل میان‌ترم)، و دیر ثبت‌شده‌ها
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { processReminders, handleReminderCallback, groupText } = await import(WORKER + "src/reminders.js");
const e5Stub = { title: "تست", start_date: "2026-11-30" };
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; const answers = [];
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  if (m === "answerCallbackQuery") { answers.push(b.text || ""); return Response.json({ ok: true, result: true }); }
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

const addEvent = (title, start, kind) => raw.prepare("INSERT INTO events (title, start_date, end_date, kind, archived) VALUES (?, ?, ?, ?, 0)").run(title, start, start, kind) && raw.prepare("SELECT MAX(id) AS id FROM events").get().id;
const ids = {};
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

// تأیید مالک
const cb = (uid, data) => ({ id: "c" + Math.random(), data, from: { id: uid }, message: { chat: { id: 5 } } });
const groupMsgs = () => sent.filter((x) => String(x.chat_id) === "-100555");
sent.length = 0; answers.length = 0;
Date.now = () => Date.UTC(Y, N, 14, 10 - 3, 0 - 30);
await handleReminderCallback(env, cb(7, `rm2:s:${ids.e3}:now`));
ok("non-owner tap: nothing sent to the group", groupMsgs().length === 0);
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e3}:now`));
ok("owner approve: sent to the group with the title", groupMsgs().length === 1 && groupMsgs()[0].text.includes("عادی دیر") && groupMsgs()[0].text.includes("فردا"));
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e3}:now`));
ok("second tap on the same reminder: not sent again", groupMsgs().length === 1 && answers.includes("این یادآوری قبلاً جواب گرفته"));
await handleReminderCallback(env, cb(5, `rm2:r:${ids.e4}:now`));
ok("owner reject: nothing sent to the group", groupMsgs().length === 1 && answers.includes("ارسال نشد"));

// بایگانی: دکمه‌ی قدیمی رویداد بایگانی‌شده، «دیگه فعال نیست» می‌گوید
raw.exec(`UPDATE events SET archived = 1 WHERE id = ${ids.e2}`);
sent.length = 0; answers.length = 0;
await handleReminderCallback(env, cb(5, `rm2:s:${ids.e2}:pre1`));
ok("archived event button: says it is no longer active, nothing sent", answers.includes("این رویداد دیگه فعال نیست") && groupMsgs().length === 0);

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
