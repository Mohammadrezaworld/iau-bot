// پاسخ تکراری /week: یادآوری «جواب بالاست» بعد از ۲۰ دقیقه پاک می‌شه
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
const sent = []; let mid = 1200; let failReaction = false;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  const id = ++mid;
  sent.push({ m, ...b, _id: id });
  if (m === "setMessageReaction" && failReaction) return Response.json({ ok: false, description: "reaction not allowed" }, { status: 400 });
  return Response.json({ ok: true, result: m === "setMessageReaction" ? true : { message_id: id } });
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
const note = sent.find((x) => x.m === "sendMessage" && /بالاست/.test(x.text || ""));
ok("duplicate /week gets the 'above' note as a reply", !!note && !!note.reply_to_message_id);
const noteId = note && note._id;
const row = note && raw.prepare("SELECT delete_at_utc AS d FROM metro_messages WHERE chat_id = -100555 AND message_id = ?").get(noteId);
ok("note is scheduled for deletion ~1200s later", row && Math.abs(row.d - (Math.floor(base / 1000) + 1200)) <= 3);

// ۶۱ ثانیه بعد: کرون پاک‌سازی باید یادآوری را حذف کند
Date.now = () => base + 1210000;
sent.length = 0;
await cleanupMetroMessages(env);
ok("note is deleted by the minute cleanup after 1200s", !!note && sent.some((x) => x.m === "deleteMessage" && x.message_id === noteId));
Date.now = () => base;

// پرسش آزاد تکراری: واکنش 👀 روی پرسش + یادآوری کوتاه، حداکثر یکی در هر ۶۰ ثانیه
Date.now = () => base + 1300000;
const q = "دوستان هفته زوجیم یا فرد؟";
// اولین پرسش تکراری: واکنش روی پرسش + یادآوری کوتاه
sent.length = 0;
await g(203, q, 6010);
const react = sent.find((x) => x.m === "setMessageReaction");
ok("duplicate question gets a reaction on the question itself", !!react && react.message_id === 6010 && react.reaction[0].emoji === "👀");
const qNote = sent.find((x) => x.m === "sendMessage" && /بالاست/.test(x.text || ""));
ok("duplicate question also gets a short note as a reply", !!qNote && typeof qNote.reply_to_message_id === "number");
ok("question message is not deleted", !sent.some((x) => x.m === "deleteMessage" && x.message_id === 6010));

// دومین پرسش تکراری در همان ۶۰ ثانیه: فقط واکنش، بدون یادآوری تازه
sent.length = 0;
await g(206, q, 6013);
ok("second duplicate within 1200s gets reaction only", sent.some((x) => x.m === "setMessageReaction" && x.message_id === 6013) && !sent.some((x) => x.m === "sendMessage"));

// بعد از ۶۰ ثانیه: یادآوری دوباره مجاز است
Date.now = () => base + 2510000;
sent.length = 0;
await g(207, q, 6014);
ok("after 1200s a new duplicate gets the note again", sent.some((x) => x.m === "sendMessage" && /بالاست/.test(x.text || "")));

// واکنش شکست بخورد: جواب تازه داده می‌شود (کاربر بی‌جواب نمی‌ماند)
failReaction = true;
sent.length = 0;
await g(208, q, 6015);
failReaction = false;
ok("if reaction fails, a fresh reply to the question is sent", sent.some((x) => x.m === "sendMessage" && x.reply_to_message_id === 6015));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
