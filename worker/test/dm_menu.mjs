import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 100; const memberStatus = { v: "member" }; let notModified = false;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  if (m === "createChatInviteLink") return Response.json({ ok: true, result: { invite_link: "https://t.me/+JOIN1" } });
  if (m === "editMessageText" && notModified) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" }), { status: 400, headers: { "content-type": "application/json" } });
  if (m === "getChatMember") return Response.json({ ok: true, result: { status: memberStatus.v, is_member: memberStatus.v === "restricted" } });
  return Response.json({ ok: true, result: { message_id: ++mid } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-1004434418889", JOZVE_PUBLIC_USERNAME: "iautcloud", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
raw.exec("INSERT INTO admins (user_id,is_owner) VALUES (7,0)"); raw.exec("INSERT INTO admin_roles (user_id,role) VALUES (7,'full')");
raw.exec("INSERT INTO jozve_files (course,professor,title,file_name,file_size,channel_msg_id,created_utc) VALUES ('ریاضی ۱','استاد احمدی','فصل اول','a.pdf',1,10,1)");
raw.exec("INSERT INTO jozve_files (course,professor,title,file_name,file_size,channel_msg_id,created_utc) VALUES ('ریاضی ۱','استاد احمدی','فصل دوم','b.pdf',1,11,2)");
raw.exec("INSERT INTO exam_files (course,professor,title,file_name,file_size,channel_msg_id,created_utc) VALUES ('فیزیک','استاد رضایی','1404','e.pdf',1,20,1)");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const dm = (uid, text) => hook({ message: { message_id: 1, chat: { id: uid, type: "private" }, from: { id: uid }, text } });
let clk = 0; const baseNow = Date.now; Date.now = () => baseNow() + clk;
const cb = (uid, data, msgId, chatId = uid) => (clk += 1500, hook({ callback_query: { id: "q" + Math.random(), from: { id: uid }, data, message: { message_id: msgId, chat: { id: chatId, type: "private" } } } }));
const calls = (m) => sent.filter(x => x.m === m);
const FORBIDDEN = ["copyMessage", "sendDocument", "forwardMessage", "sendMediaGroup", "sendPhoto", "sendVideo"];
const noForbidden = () => !sent.some(x => FORBIDDEN.includes(x.m));

// 1. non-member
memberStatus.v = "left"; sent.length = 0;
await dm(77, "/jozve");
ok("non-member gets gate message with join button only", calls("sendMessage").some(x => /عضو گروه/.test(x.text) && x.reply_markup && x.reply_markup.inline_keyboard[0][0].url === "https://t.me/+JOIN1" && x.reply_markup.inline_keyboard.length === 1));
ok("non-member: no menu state", !raw.prepare("select 1 from settings where key='dm_menu:77'").get());

// 2. member opens menu
memberStatus.v = "member"; sent.length = 0;
await dm(77, "/jozve");
const menu = calls("sendMessage").at(-1);
ok("member gets main menu with 2 buttons", menu && menu.reply_markup.inline_keyboard[0].length === 2);
const menuId = mid;

// 3. second /jozve deletes previous menu
sent.length = 0; await dm(77, "/menu");
ok("second open deletes previous menu", calls("deleteMessage").some(x => x.message_id === menuId));
const menu2 = mid;

// 4. navigation via edit
sent.length = 0; await cb(77, "d:n", menu2);
ok("d:n edits menu to categories", calls("editMessageText").length === 1 && /دسته/.test(calls("editMessageText")[0].text));
const catBtn = calls("editMessageText")[0].reply_markup.inline_keyboard[0][0].callback_data;
sent.length = 0; await cb(77, catBtn, menu2);
const courseBtn = calls("editMessageText")[0].reply_markup.inline_keyboard[0][0];
ok("category shows course button", courseBtn && courseBtn.text === "ریاضی ۱");
sent.length = 0; await cb(77, courseBtn.callback_data, menu2);
const profBtn = calls("editMessageText")[0].reply_markup.inline_keyboard[0][0];
ok("course shows professor button", profBtn && profBtn.text === "استاد احمدی");
sent.length = 0; await cb(77, profBtn.callback_data, menu2);
const linkRows = calls("editMessageText")[0].reply_markup.inline_keyboard;
const urls = linkRows.flat().filter(b => b.url).map(b => b.url);
ok("files are URL buttons to channel posts", urls.includes("https://t.me/iautcloud/10") && urls.includes("https://t.me/iautcloud/11"));
ok("no file sent in DM", noForbidden());
const longest = Math.max(...raw.prepare("select course, professor from jozve_files").all().flatMap(r => [r.course.length]));
const allCb = [catBtn, courseBtn.callback_data, profBtn.callback_data, "d:fn" + "ا".repeat(14) + "|" + "ب".repeat(14), "d:fn" + "ا".repeat(14) + "|" + "ب".repeat(14).slice(0,14)];
ok("callback_data within 64 bytes", allCb.every(c => new TextEncoder().encode(c).length <= 64));

// 5. exam branch
sent.length = 0; await cb(77, "d:e", menu2);
ok("exam categories exist", /نمونه‌سوال/.test(calls("editMessageText")[0].text));

// 5b. welcome host keeps its text on first navigation
sent.length = 0; await dm(77, "/start");
const hostId = mid;
sent.length = 0; await cb(77, "d:n", hostId);
ok("welcome not edited; keyboard removed", !calls("editMessageText").length && calls("editMessageReplyMarkup").some(x => x.message_id === hostId && x.reply_markup.inline_keyboard.length === 0));
ok("categories sent as new message", calls("sendMessage").length === 1 && /دسته|جزوه/.test(calls("sendMessage")[0].text) && calls("sendMessage")[0].reply_markup);
const viewId = JSON.parse(raw.prepare("select value from settings where key='dm_menu:77'").get().value).msg;
sent.length = 0; await cb(77, "d:e", viewId);
ok("later navigation edits the new view", calls("editMessageText").length === 1 && calls("editMessageText")[0].message_id === viewId);
sent.length = 0; await cb(77, "d:x", viewId);
ok("close deletes view and welcome", calls("deleteMessage").some(x => x.message_id === viewId) && calls("deleteMessage").some(x => x.message_id === hostId));

// 5c. burst limiter: 3 quick clicks pass, 4th gets soft toast, after a second it passes again
{
  await dm(77, "/menu");
  const h = JSON.parse(raw.prepare("select value from settings where key='dm_menu:77'").get().value).msg;
  sent.length = 0;
  const hk = (data) => hook({ callback_query: { id: "b" + Math.random(), from: { id: 77 }, data, message: { message_id: h, chat: { id: 77, type: "private" } } } });
  clk += 5000; // سهمیه‌ی کامل
  await hk("d:n"); await hk("d:n"); await hk("d:n");
  const before = calls("answerCallbackQuery").filter(x => !x.show_alert && x.text).length;
  await hk("d:n");
  const soft = calls("answerCallbackQuery").filter(x => x.text === "لطفاً کمی صبر کن.").length;
  ok("4th rapid click gets soft toast", soft === 1 && before === 0);
  clk += 2000;
  sent.length = 0; await hk("d:e");
  ok("after a pause clicks work again", calls("editMessageText").length === 1);
}

// 6. non-owner clicks
sent.length = 0; await cb(88, "d:n", menu2, 77);
ok("non-owner gets alert", calls("answerCallbackQuery")[0] && calls("answerCallbackQuery")[0].text === "این منو مال تو نیست!");

// 7. stale menu
sent.length = 0; await cb(77, "d:n", 999);
ok("stale menu gets expired alert", calls("answerCallbackQuery")[0].text.includes("منقضی"));

// 8. close
const curMenu = JSON.parse(raw.prepare("select value from settings where key='dm_menu:77'").get().value).msg;
sent.length = 0; await cb(77, "d:x", curMenu);
ok("close deletes menu and clears state", calls("deleteMessage").some(x => x.message_id === curMenu) && !raw.prepare("select 1 from settings where key='dm_menu:77'").get());

// 9. regular non-command message: silent
sent.length = 0; await dm(77, "/call");
ok("member: /call answered in DM", sent.some(x => x.m === "sendMessage" || x.m === "sendHtml") && sent.length > 0);
memberStatus.v = "left"; sent.length = 0; await dm(77, "/call");
ok("non-member: /call gets gate message with join button", calls("sendMessage").length === 1 && /عضو گروه/.test(calls("sendMessage")[0].text) && calls("sendMessage")[0].reply_markup.inline_keyboard[0][0].url === "https://t.me/+JOIN1");
const inv = sent.filter(x => x.m === "createChatInviteLink");
sent.length = 0; memberStatus.v = "left"; await dm(77, "/call");
ok("invite link cached (created once)", inv.length <= 1 && sent.filter(x => x.m === "createChatInviteLink").length === 0);
memberStatus.v = "member";
sent.length = 0; await dm(77, "/updates");
ok("/updates silent in DM", sent.filter(x => x.m === "sendMessage" || x.m === "sendHtml").length === 0);
memberStatus.v = "member"; sent.length = 0; await dm(77, "/unknownthing");
ok("unknown text in DM stays silent", sent.length === 0);
sent.length = 0; await dm(77, "/start");
ok("member /start: welcome mentions /menu and /call", calls("sendMessage").some(x => /\/menu/.test(x.text) && /\/call/.test(x.text)));
ok("member /start: one message with welcome and menu buttons", calls("sendMessage").length === 1 && calls("sendMessage")[0].reply_markup.inline_keyboard[0].length === 2);
sent.length = 0; await dm(77, "/menu");
ok("/menu opens menu", calls("sendMessage").length === 1 && calls("sendMessage")[0].reply_markup.inline_keyboard[0].length === 2);
ok("welcome has no /updates", calls("sendMessage").every(x => !/updates/.test(x.text || "")));

memberStatus.v = "left"; sent.length = 0; await dm(88, "/start");
ok("non-member /start: welcome + gate, no menu", calls("sendMessage").length === 1 && /خوش اومدی/.test(calls("sendMessage")[0].text) && /عضو گروه/.test(calls("sendMessage")[0].text) && calls("sendMessage")[0].reply_markup.inline_keyboard[0][0].url === "https://t.me/+JOIN1");
memberStatus.v = "member";

// 10. membership revoked in middle of menu
sent.length = 0; await dm(77, "/jozve"); const m3 = mid;
memberStatus.v = "left"; sent.length = 0; await cb(77, "d:n", m3);
ok("left group: click gets not-member alert and menu removed", calls("answerCallbackQuery")[0].text.includes("عضو گروه") && calls("deleteMessage").some(x => x.message_id === m3));
memberStatus.v = "member";

// 11. max life
sent.length = 0; await dm(77, "/jozve"); const m4 = mid;
const realNow = Date.now; Date.now = () => realNow() + 241000;
sent.length = 0; await cb(77, "d:n", m4);
ok("menu expires after max life", calls("answerCallbackQuery")[0].text.includes("منقضی"));
Date.now = realNow;

// 12. admin not affected by DM menu
sent.length = 0; await dm(7, "/jozve");
ok("admin /jozve opens DM menu too", sent.some(x => x.m === "sendMessage" && x.reply_markup && x.reply_markup.inline_keyboard?.[0]?.[0]?.callback_data === "d:n"));
sent.length = 0; await dm(7, "/menu");
ok("admin /menu opens admin button menu (am:)", sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "am:0" && x.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data === "am:1"));
ok("admin (non-owner) menu hides scrape settings button", sent.some(x => x.m === "sendMessage") && !sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === "am:2")));
sent.length = 0; await dm(5, "/menu");
ok("owner /menu opens admin button menu incl. owner buttons", sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === "am:5")));
ok("owner menu has scrape settings button (am:2)", sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === "am:2" && b.text === "تنظیمات ارسال")));
sent.length = 0; await cb(5, "am:0", 900);
ok("owner button am:0 runs /status from the admin menu",sent.some(x => x.m === "sendMessage" && String(x.text).includes("وضعیت ربات")));
sent.length = 0; await cb(7, "am:1", 901);
ok("status button shows refresh button (st:r)", sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "st:r"));
sent.length = 0; await cb(7, "st:r", mid);
ok("refresh edits status message in place", calls("editMessageText").length === 1 && /ارسال به گروه/.test(calls("editMessageText")[0].text) && calls("editMessageText")[0].reply_markup.inline_keyboard[0][0].callback_data === "st:r");
notModified = true; sent.length = 0; await cb(7, "st:r", mid);
ok("refresh with unchanged status: no error, callback answered", calls("answerCallbackQuery").length === 1);
notModified = false;
sent.length = 0; await dm(5, "/scrape_settings");
ok("scrape settings panel has refresh button (ss:r)", sent.some(x => x.m === "sendMessage" && x.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === "ss:r")));
sent.length = 0; await cb(5, "ss:r", 903);
ok("scrape settings refresh edits panel in place", calls("editMessageText").length === 1 && /تنظیمات ارسال/.test(calls("editMessageText")[0].text) && calls("editMessageText")[0].reply_markup.inline_keyboard.flat().some(b => b.callback_data === "ss:r"));
notModified = true; sent.length = 0; await cb(5, "ss:r", 903);
ok("scrape settings refresh with unchanged panel: no error", calls("answerCallbackQuery").length === 1);
notModified = false;
sent.length = 0; await dm(5, "/call");
ok("owner /call still answered", sent.length > 0);
sent.length = 0; await dm(5, "/metro");
ok("owner /metro responds", sent.some(x => x.m === "sendMessage"));

ok("never sent files in DM", noForbidden());
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
