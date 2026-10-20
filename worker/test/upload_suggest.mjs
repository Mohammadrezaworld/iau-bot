// تطبیق نام آپلود: نام دقیق فوری ثبت می‌شه؛ نام نزدیک/تازه تأیید ادمین می‌خواد؛ آلبوم بدون کپشن به درخواست باز می‌پیونده
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { handleJozvePost, handleJozvePickCallback } = await import(WORKER + "src/jozve.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
raw.exec(`INSERT INTO book_files (course, professor, title, file_name, file_size, channel_msg_id, created_utc) VALUES ('ریاضی عمومی ۱','استوارت','',' ',0,9001,1)`);
const mk = (sql, args = []) => ({
  bind: (...a) => mk(sql, a),
  first: async () => raw.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: raw.prepare(sql).all(...args) }),
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const db = { prepare: (sql) => mk(sql) };
const sent = []; let mid = 3000;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: ++mid } });
};
const CH = "-1004434418889";
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: CH, DB: db };
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const post = (id, body) => handleJozvePost(env, { message_id: id, chat: { id: Number(CH), type: "channel" }, ...body });
const doc = (name) => ({ document: { file_name: name, file_size: 100 } });
const rowsOf = (t, id) => raw.prepare(`SELECT course, professor FROM ${t} WHERE channel_msg_id = ?`).get(id);
const lastAsk = () => [...sent].reverse().find((x) => x.m === "sendMessage" && x.reply_markup);
const btn = (ask, prefix) => ask && ask.reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith(prefix));
const cb = (uid, data) => ({ id: "cq" + Math.random(), data, from: { id: uid }, message: { message_id: 1, chat: { id: Number(CH) } } });

// ۱. نام دقیق: فوری ثبت، بدون درخواست تأیید
sent.length = 0;
await post(4001, { ...doc("a.pdf"), caption: "کتاب | ریاضی عمومی ۱ | استوارت" });
ok("exact names are stored immediately", !!rowsOf("book_files", 4001));
ok("exact names do not ask for confirmation", !lastAsk() || !btn(lastAsk(), "jp:"));

// ۲. کپشن نزدیک (املای متفاوت): پیشنهاد نام ثبت‌شده، و تا تأیید چیزی ثبت نمی‌شه
sent.length = 0;
await post(4002, { ...doc("b.pdf"), caption: "کتاب | ریاضی۱ | استوارت" });
const ask2 = lastAsk();
ok("near name asks for confirmation and stores nothing yet", !rowsOf("book_files", 4002) && !!btn(ask2, "jp:s:"));
ok("confirmation shows the suggested name", ask2 && /ریاضی عمومی ۱/.test(ask2.reply_markup && ask2.text));
await handleJozvePickCallback(env, cb(5, btn(ask2, "jp:s:").callback_data));
ok("admin confirms suggestion: stored with suggested names", rowsOf("book_files", 4002)?.course === "ریاضی عمومی ۱");

// ۳. نام کاملاً تازه با تأیید «همین نام»
sent.length = 0;
await post(4003, { ...doc("c.pdf"), caption: "کتاب | زبان تخصصی | آقای ب" });
const ask3 = lastAsk();
ok("new name asks and offers only keep-caption and cancel", !btn(ask3, "jp:s:") && !!btn(ask3, "jp:c:") && !!btn(ask3, "jp:x:"));
await handleJozvePickCallback(env, cb(5, btn(ask3, "jp:c:").callback_data));
ok("new name stored after confirmation", rowsOf("book_files", 4003)?.course === "زبان تخصصی");

// ۴. لغو: هیچ ردیفی ثبت نمی‌شه
sent.length = 0;
await post(4004, { ...doc("d.pdf"), caption: "کتاب | فیزیک | کسی" });
await handleJozvePickCallback(env, cb(5, btn(lastAsk(), "jp:x:").callback_data));
ok("cancel stores nothing", !rowsOf("book_files", 4004));

// ۵. غیرادمین نمی‌تواند تأیید کند
sent.length = 0;
await post(4005, { ...doc("e.pdf"), caption: "کتاب | ریاضی۱ | استوارت" });
const ask5 = lastAsk();
await handleJozvePickCallback(env, cb(999, btn(ask5, "jp:s:").callback_data));
ok("non-admin cannot confirm", !rowsOf("book_files", 4005));
await handleJozvePickCallback(env, cb(5, btn(ask5, "jp:s:").callback_data));
ok("admin can still confirm afterwards", rowsOf("book_files", 4005)?.course === "ریاضی عمومی ۱");

// ۶. آلبوم: کپشن روی اولی؛ بقیه‌ی بی‌کپشن به درخواست همان آلبوم می‌پیوندن و با تأیید ثبت می‌شن
sent.length = 0;
await post(4006, { ...doc("f1.pdf"), media_group_id: "G7", caption: "کتاب | فیزیک۲ | زید" });
await post(4007, { ...doc("f2.pdf"), media_group_id: "G7" });
const ask6 = lastAsk();
ok("album with unknown names: nothing stored before confirm", !rowsOf("book_files", 4006) && !rowsOf("book_files", 4007));
ok("album member without caption does not error", !sent.some((x) => x.m === "sendMessage" && /کپشن باید/.test(x.text || "")));
await handleJozvePickCallback(env, cb(5, btn(ask6, "jp:c:").callback_data));
ok("album: both files stored after confirmation", !!rowsOf("book_files", 4006) && !!rowsOf("book_files", 4007));
await post(4008, { ...doc("f3.pdf"), media_group_id: "G7" });
ok("album member arriving after confirmation is stored directly", !!rowsOf("book_files", 4008));

// ۷. کپشن دقیق و بقیه‌ی آلبوم: فوری
sent.length = 0;
await post(4009, { ...doc("g1.pdf"), media_group_id: "G8", caption: "کتاب | ریاضی عمومی ۱ | استوارت" });
await post(4010, { ...doc("g2.pdf"), media_group_id: "G8" });
ok("exact album stores all members immediately", !!rowsOf("book_files", 4009) && !!rowsOf("book_files", 4010));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
