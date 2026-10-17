// جزوه/کتاب/دوره/چنل مفید: ثبت عکس و آلبوم، پیام تأیید با TTL ۱۲۰ ثانیه، و منوی پیوی برای نوع‌های جدید
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 500;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  if (m === "getChatMember") return Response.json({ ok: true, result: { status: "member" } });
  return Response.json({ ok: true, result: { message_id: ++mid } });
};
const CH = -1004434418889;
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: String(CH), JOZVE_PUBLIC_USERNAME: "iautcloud", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const nowS = () => Math.floor(Date.now() / 1000);
const texts = () => sent.filter((x) => x.m === "sendMessage").map((x) => x.text || "");
const confirmations = () => texts().filter((t) => t.startsWith("ثبت شد"));
const rows = (t) => raw.prepare(`SELECT course, professor, channel_msg_id FROM ${t} ORDER BY id`).all();

// پست کانال؛ id = شناسه‌ی پیام کانال
const post = (id, body) => hook({ channel_post: { message_id: id, chat: { id: CH, type: "channel" }, ...body } });
const doc = (name) => ({ document: { file_name: name, file_size: 1000 } });
const photo = () => ({ photo: [{ file_size: 10 }, { file_size: 900 }] });

// ۱. عکس با کپشن کتاب
sent.length = 0; await post(1001, { ...photo(), caption: "کتاب | ریاضی عمومی | استوارت" });
ok("photo with book caption is stored in book_files", rows("book_files").some((r) => r.channel_msg_id === 1001 && r.course === "ریاضی عمومی"));
ok("book confirmation sent", confirmations().some((t) => /کتاب/.test(t)));

// ۲. دوره و چنل مفید
await post(1002, { ...doc("c.pdf"), caption: "دوره | پایتون پیشرفته | علی رضایی" });
await post(1003, { ...photo(), caption: "چنل | ریاضیات کاربردی | ترجمه" });
ok("course caption stored in course_files", rows("course_files").some((r) => r.channel_msg_id === 1002));
ok("channel caption stored in channel_files", rows("channel_files").some((r) => r.channel_msg_id === 1003));

// ۳. فرمت ناقص: پیام خطا و بدون ثبت
sent.length = 0; await post(1004, { ...doc("x.pdf"), caption: "کتاب | فقط نام" });
ok("bad book format: error, nothing stored", texts().some((t) => /فرمت کتاب/.test(t)) && !rows("book_files").some((r) => r.channel_msg_id === 1004));

// ۴. ویدیو نادیده گرفته می‌شه
sent.length = 0; await post(1005, { video: { file_size: 5 }, caption: "کتاب | ویدیو | کسی" });
ok("video ignored (no insert, no message)", sent.length === 0 && !rows("book_files").some((r) => r.channel_msg_id === 1005));

// ۵. آلبوم: کپشن روی اولی، بقیه بدون کپشن
sent.length = 0;
await post(2001, { ...photo(), media_group_id: "G1", caption: "کتاب | جبر خطی | کیوان" });
await post(2002, { ...photo(), media_group_id: "G1" });
await post(2003, { ...doc("p3.pdf"), media_group_id: "G1" });
ok("album: all three members stored in book_files", [2001, 2002, 2003].every((id) => rows("book_files").some((r) => r.channel_msg_id === id && r.course === "جبر خطی")));
ok("album: exactly one confirmation for the group", confirmations().length === 1);
ok("album: group remembered", raw.prepare("SELECT kind FROM album_groups WHERE media_group_id = 'G1'").get()?.kind === "book");

// ۶. عضو آلبوم بدون کپشن و بدون گروه ثبت‌شده: خطا
sent.length = 0; await post(2004, { ...photo(), media_group_id: "G9" });
ok("album member without caption and no group: error, not stored", texts().some((t) => /کپشن/.test(t)) && !rows("book_files").some((r) => r.channel_msg_id === 2004));

// ۷. جزوه‌ی قدیمی همچنان کار می‌کنه و پیام تأیید ثبت می‌شه
sent.length = 0; await post(3001, { ...doc("ch1.pdf"), caption: "درس تست | استاد الف" });
ok("old note caption still stored in jozve_files", rows("jozve_files").some((r) => r.channel_msg_id === 3001 && r.course === "درس تست"));
ok("old note confirmation shows جزوه", confirmations().some((t) => /جزوه/.test(t)));

// ۸. پیام تأیید بعد از ۱۲۰ ثانیه پاک می‌شه (ثبت در metro_messages با زمان حذف)
const confirmMsg = sent.find((x) => x.m === "sendMessage" && /ثبت شد/.test(x.text || ""));
const confId = mid; // آخرین پیام ساخته‌شده همین تأیید است
const ttl = raw.prepare("SELECT delete_at_utc AS d FROM metro_messages WHERE message_id = ?").get(confId)?.d;
ok("confirmation scheduled for deletion ~120s later", ttl && Math.abs(ttl - (nowS() + 120)) <= 3);

// ۹. منوی پیوی: کتاب → نام‌ها → استاد → فایل با لینک کانال
const dm = (uid, text) => hook({ message: { message_id: 1, chat: { id: uid, type: "private" }, from: { id: uid }, text } });
const cb = (uid, msgId, data) => hook({ callback_query: { id: "cq" + Math.random(), from: { id: uid }, data, message: { message_id: msgId, chat: { id: uid, type: "private" } } } });
const lastMenuId = () => { const s = sent.filter((x) => x.m === "sendMessage" && x.reply_markup); return s.length; };
sent.length = 0; await dm(77, "/jozve");
const menu = sent.find((x) => x.m === "sendMessage" && x.reply_markup);
ok("DM main menu shows کتاب, دوره and چنل مفید buttons", menu && ["d:b", "d:u", "d:h"].every((d) => JSON.stringify(menu.reply_markup).includes(`"${d}"`)));
const menuMsgId = mid; // پیام منوی ارسال‌شده آخرین پیام است
sent.length = 0; await cb(77, menuMsgId, "d:b");
const names = sent.find((x) => x.m === "editMessageText");
ok("DM کتاب lists book names", names && JSON.stringify(names.reply_markup).includes("ریاضی عمومی") && JSON.stringify(names.reply_markup).includes("d:obریاضی عمومی"));
sent.length = 0; await cb(77, menuMsgId, "d:obریاضی عمومی");
const profs = sent.find((x) => x.m === "editMessageText");
ok("DM book shows author buttons with back to list", profs && JSON.stringify(profs.reply_markup).includes("d:fbریاضی عمومی|استوارت") && JSON.stringify(profs.reply_markup).includes('"d:b"'));

// ۱۰. برچسب دکمه‌ها برای آلبوم با ترم یکسان یکتا باشه
raw.exec("INSERT INTO exam_files (course, professor, title, file_name, file_size, channel_msg_id, created_utc) VALUES ('ریاضی','استوارت','ترم اول','',0,4001,1),('ریاضی','استوارت','ترم اول','',0,4002,1)");
const realNow = Date.now; Date.now = () => realNow() + 60000; // بعد از سهمیه‌ی کلیک قبلی
sent.length = 0; await cb(77, menuMsgId, "d:eدسته");
sent.length = 0; await cb(77, menuMsgId, "d:fe" + "ریاضی|استوارت");
const files = sent.find((x) => x.m === "editMessageText");
const labels = files ? files.reply_markup.inline_keyboard.flat().map((b) => b.text).filter((t) => /ترم/.test(t)) : [];
ok("DM file buttons for same term are distinct", labels.length === 2 && labels[0] !== labels[1]);
Date.now = realNow;

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
