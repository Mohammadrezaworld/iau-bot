// Regression tests: callbackهای keyword/holiday ابتدا spinner را می‌بندند، سپس تغییر را انجام می‌دهند و نتیجه را در پیام نشان می‌دهند.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const mk = (sql, args = []) => ({
  bind: (...a) => mk(sql, a),
  first: async () => raw.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: raw.prepare(sql).all(...args) }),
  run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const db = { prepare: (sql) => mk(sql) };
const { handleKeywordCallback } = await import(WORKER + "src/keywords.js");
const { handleHolidayCallback } = await import(WORKER + "src/holidays.js");
const { handleJozveCallback, handleJozveRemoveCallback } = await import(WORKER + "src/jozve.js");
const { tg } = await import(WORKER + "src/telegram.js");
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
const calls = [];
const messages = [];
globalThis.fetch = async (u, o) => {
  const method = String(u).split("/").pop();
  const body = o && o.body ? JSON.parse(o.body) : {};
  calls.push(method);
  if (method === "sendMessage") messages.push(body);
  return Response.json({ ok: true, result: { message_id: 101 } });
};
const cb = (id, data, uid = 5) => ({ id, data, from: { id: uid }, message: { message_id: 50, chat: { id: 5, type: "private" } } });
let fails = 0;
const ok = (name, condition) => { console.log((condition ? "PASS " : "FAIL ") + name); if (!condition) fails++; };

raw.prepare("INSERT INTO settings (key, value) VALUES ('keywords', ?)").run(JSON.stringify(["test"]));
calls.length = 0; messages.length = 0;
await handleKeywordCallback(env, cb("kw-ack-test", "kw:y:test"));
const keywords = JSON.parse(raw.prepare("SELECT value FROM settings WHERE key = 'keywords'").get().value);
ok("keyword delete: callback ack precedes mutation and result remains visible", calls[0] === "answerCallbackQuery" && messages.some((m) => m.text.includes("کلمه «test» حذف شد")) && keywords.length === 0);

raw.prepare("INSERT INTO holidays (date, title) VALUES ('2026-11-30', 'تعطیل تست')").run();
calls.length = 0; messages.length = 0;
await handleHolidayCallback(env, cb("holiday-ack-test", "hol:y:2026-11-30"));
const holiday = raw.prepare("SELECT date FROM holidays WHERE date = '2026-11-30'").get();
ok("holiday delete: callback ack precedes mutation and result remains visible", calls[0] === "answerCallbackQuery" && messages.some((m) => m.text.includes("حذف شد")) && holiday === undefined);

calls.length = 0;
await handleKeywordCallback(env, cb("kw-close-ack-test", "kw:n"));
ok("keyword close: callback ack precedes message deletion", calls[0] === "answerCallbackQuery" && calls[1] === "deleteMessage");

raw.prepare("INSERT INTO jozve_files (course, professor, title, file_name, file_size, channel_msg_id, created_utc) VALUES ('ریاضی', 'استاد تست', 'جزوه تست', 'test.pdf', 1, 99, 1)").run();
calls.length = 0; messages.length = 0;
await handleJozveRemoveCallback(env, cb("jozve-remove-ack-test", "jrm:y:1"));
const file = raw.prepare("SELECT id FROM jozve_files WHERE id = 1").get();
ok("jozve removal: callback ack precedes delete and confirmation stays visible", calls[0] === "answerCallbackQuery" && messages.some((m) => m.text === "فایل از فهرست حذف شد.") && file === undefined);

calls.length = 0; messages.length = 0;
const emptyMenuCb = { ...cb("jozve-empty-menu-test", "j:e"), message: { message_id: 55, chat: { id: -100555, type: "supergroup" } } };
await tg(env, "answerCallbackQuery", { callback_query_id: emptyMenuCb.id, text: "" }); // router early ack
await handleJozveCallback(env, emptyMenuCb);
ok("jozve empty category: prior toast remains visible after early ack", calls[0] === "answerCallbackQuery" && messages.some((m) => m.text === "هنوز چیزی ثبت نشده."));

calls.length = 0;
await handleJozveRemoveCallback(env, cb("jozve-remove-close-test", "jrm:n"));
ok("jozve remove close: callback ack precedes message deletion", calls[0] === "answerCallbackQuery" && calls[1] === "deleteMessage");

console.log(fails ? `FAILED ${fails}` : "ALL PASSED");
process.exit(fails ? 1 : 0);
