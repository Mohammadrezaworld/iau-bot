// پرسش آزاد «زوج یا فرد؟» در گروه: همان پاسخ /week؛ پیام پرسش کاربر پاک نمی‌شه
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const { isParityQuestion } = await import(WORKER + "src/public.js");
const { weekIndex, parityOf, tehranToday } = await import(WORKER + "src/calendar.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 900;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: ++mid } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-1004434418889", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const g = (uid, text, id) => hook({ message: { message_id: id, chat: { id: -100555, type: "supergroup" }, from: { id: uid }, text } });

// ۱. عبارت‌های فهرست‌شده و تنوع‌هاشون
const yes = ["زوج یا فرد؟", "زوج یا فرد ؟", "این هفته زوج یا فرد؟", "این هفته فرد یا زوج؟", "این هفته فرد هست یا زوج؟", "این هفته زوج هست یا فرد؟", "این‌هفته زوج یا فرد؟", "این هفته زوجه یا فرده؟", "زوجه یا فرده ؟", ];
ok("listed phrases and colloquial forms are recognised", yes.every((t) => isParityQuestion(t)));
const no = ["سلام", "کلاس امروز داریم؟", "زوج خوبه", "این هفته کلاس داریم یا نه؟", "این هفته فرد هست", "این هفته زوج هست", "این هفته زوج یا فرد هست یا نه بگو", "کلاس زوج‌ها ساعت ده است", "زوج؟", "فرد؟", "این هفته فرده؟", ""];
ok("unrelated and statements are not recognised", no.every((t) => !isParityQuestion(t)));

// ۲. پاسخ در گروه: همان شماره و زوج/فرد /week، و پیام پرسش پاک می‌شه
const startIso = "2026-09-12";
const today = tehranToday();
const idx = weekIndex(startIso, today);
sent.length = 0; await g(101, "این هفته فرد هست یا زوج؟", 5001);
const ans = sent.find((x) => x.m === "sendMessage" && /هفته/.test(x.text || ""));
ok("group question gets the /week answer", !!ans && ans.text.includes(parityOf(idx)) && ans.text.includes(`هفته`));
ok("question message is kept (not deleted)", !sent.some((x) => x.m === "deleteMessage" && x.message_id === 5001));
ok("answer is a reply to the question", !!ans && ans.reply_to_message_id === 5001);

// ۳. پیام معمولی گروه بی‌جواب می‌مونه
sent.length = 0; await g(102, "سلام بچه‌ها", 5002);
ok("normal group message gets no reply", sent.filter((x) => x.m === "sendMessage").length === 0);

// ۴. پرسش دوم از کاربر دیگر: جواب تکراری زیر پاسخ قبلی (کش /week)
sent.length = 0; await g(103, "زوج یا فرد؟", 5003);
ok("repeated question replies under the earlier answer", sent.some((x) => x.m === "sendMessage" && /بالاتره/.test(x.text || "")));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
