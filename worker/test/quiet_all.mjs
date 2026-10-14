import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
const SRC = WORKER + "src";
const HOUR = Number(process.env.TEHRAN_HOUR); // ساعت تهران برای زمان ثابت
const utcMs = Date.UTC(2026, 9, 14, HOUR - 4, 30, 0); // 2026-10-14 HH:00 Tehran
globalThis.Date.now = () => utcMs;
let calls = [];
globalThis.fetch = async (url, opts) => {
  const m = String(url).split("/").pop();
  const b = opts && typeof opts.body === "string" ? JSON.parse(opts.body) : {};
  calls.push({ m, chat: b.chat_id });
  return { status: 200, json: async () => ({ ok: true, result: m === "sendMessage" ? { message_id: 700 } : true }) };
};
const TOKEN = "111111111:TEST_ONLY_NOT_A_REAL_TOKEN";
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const wrap = (sql) => { const make = (args) => ({ first: async () => raw.prepare(sql).get(...args) ?? null, all: async () => ({ results: raw.prepare(sql).all(...args) }), run: async () => { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } }); return { ...make([]), bind: (...a) => make(a) }; };
raw.prepare("INSERT INTO settings (key, value) VALUES ('group_id', '-1001')").run();
const env = { DB: { prepare: wrap }, OWNER_ID: "900000001", TELEGRAM_BOT_TOKEN: TOKEN, INGEST_SECRET: "s", JOZVE_CHANNEL: "-100999" };
const W = (await import(`${SRC}/index.js`)).default;
const T = await import(`${SRC}/telegram.js`);
const secret = await T.webhookSecret(env);
let uid = 1000, id = 1;
const send = async (u) => {
  calls = [];
  const res = await W.fetch(new Request("https://w/tg-webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify({ update_id: id++, ...u }) }), env);
  return { status: res.status, calls: calls.filter((c) => c.m !== "getMe") };
};
const gmsg = (text, from = ++uid) => ({ message: { message_id: id * 10, chat: { id: -1001, type: "supergroup" }, from: { id: from, is_bot: false, first_name: "x" }, text, date: 1 } });
const gcb = (data) => ({ callback_query: { id: "c" + id, from: { id: ++uid }, data, message: { message_id: 9, chat: { id: -1001, type: "supergroup" } } } });
const dm = (text, from = ++uid) => ({ message: { message_id: id * 10, chat: { id: from, type: "private" }, from: { id: from, is_bot: false, first_name: "x" }, text, date: 1 } });
const cases = [
  ["group /week", gmsg("/week")], ["group /call", gmsg("/call")], ["group /metro", gmsg("/metro")],
  ["group /updates", gmsg("/updates")], ["group /jozve", gmsg("/jozve")], ["group /event (غیرعمومی)", gmsg("/event_add x")],
  ["group button m:", gcb("m:n")], ["group button j:n", gcb("j:n")],
];
const out = [];
for (const [name, u] of cases) { const r = await send(u); out.push([name, r.status === 200 && r.calls.length === 0 ? "silent" : "ANSWERED", r.calls.map((c) => c.m).join(",")]); }
// پیوی و مالک در ساعت سکوت باید کار کنن
const d = await send(dm("/start"));
out.push(["DM /start (user)", d.calls.some((c) => c.m === "sendMessage") ? "answered" : "SILENT(bad)", d.calls.map((c) => c.m).join(",")]);
const o = await send(dm("/menu", 900000001));
out.push(["DM /menu (owner)", o.calls.some((c) => c.m === "sendMessage") ? "answered" : "SILENT(bad)", ""]);
for (const r of out) console.log(`${HOUR}:00 | ${r[0]} → ${r[1]} ${r[2]}`);
