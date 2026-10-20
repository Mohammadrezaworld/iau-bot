// پاسخ تکراری /week: یادآوری «جواب بالاتره» بعد از ۶۰ ثانیه پاک می‌شه
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const { cleanupMetroMessages } = await import(WORKER + "src/metro.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 1200;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  const id = ++mid;
  sent.push({ m, ...b, _id: id });
  return Response.json({ ok: true, result: { message_id: id } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const g = (uid, text, id) => hook({ message: { message_id: id, chat: { id: -100555, type: "supergroup" }, from: { id: uid }, text } });
const base = Date.now();

// کاربر اول: جواب اصلی
await g(201, "/week", 6001);
// کاربر دوم، همان سؤال: پاسخ تکراری با ریپلای
sent.length = 0;
await g(202, "/week", 6002);
const note = sent.find((x) => x.m === "sendMessage" && /بالاتره/.test(x.text || ""));
ok("duplicate /week gets the 'above' note as a reply", !!note && !!note.reply_to_message_id);
const noteId = note && note._id;
const row = note && raw.prepare("SELECT delete_at_utc AS d FROM metro_messages WHERE chat_id = -100555 AND message_id = ?").get(noteId);
ok("note is scheduled for deletion ~60s later", row && Math.abs(row.d - (Math.floor(base / 1000) + 60)) <= 3);

// ۶۱ ثانیه بعد: کرون پاک‌سازی باید یادآوری را حذف کند
Date.now = () => base + 61000;
sent.length = 0;
await cleanupMetroMessages(env);
ok("note is deleted by the minute cleanup after 60s", !!note && sent.some((x) => x.m === "deleteMessage" && x.message_id === noteId));
Date.now = () => base;

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
