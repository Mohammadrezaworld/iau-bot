import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
// تست دسته‌های اسکرپ: کد واقعی worker روی SQLite فایلی؛ تلگرام شبیه‌سازی‌شده.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, existsSync } from "fs";
const DBFILE = process.env.QTEST_DB; if (!DBFILE) throw new Error("QTEST_DB required");
if (existsSync(DBFILE)) rmSync(DBFILE);
const raw = new DatabaseSync(DBFILE);
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));

// ساعت قابل تنظیم: ساعت تهران
const clock = { ms: Date.UTC(2026, 9, 14, 8, 30) }; // 12:00 تهران
const atTehranHour = (h) => { clock.ms = Date.UTC(2026, 9, 14, h - 4, 30); };
globalThis.Date.now = () => clock.ms;

let chk = null;
const db = {
  prepare(sql) {
    const mk = (args) => ({
      bind: (...a) => mk(a),
      first: async () => { chk && chk(sql); return raw.prepare(sql).get(...args) ?? null; },
      all: async () => { chk && chk(sql); return { results: raw.prepare(sql).all(...args) }; },
      run: async () => { chk && chk(sql); const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) }, results: [] }; },
    });
    return mk([]);
  },
  batch: async (stmts) => {
    raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => { const r = raw.prepare(s._sql).run(...s._args); return { meta: { changes: Number(r.changes) } }; });
      raw.exec("COMMIT"); return out;
    } catch (e) { raw.exec("ROLLBACK"); throw e; }
  },
};
// bind() in batch needs _sql/_args: wrap prepare to expose them
const origPrepare = db.prepare;
db.prepare = (sql) => { const st = origPrepare(sql); const b = st.bind; st.bind = (...a) => { const o = b(...a); o._sql = sql; o._args = a; return o; }; st._sql = sql; return st; };

// ---- تلگرام شبیه‌سازی‌شده
const ok = (result) => Response.json({ ok: true, result });
let mid = 1000;
const G = { sent: [], photos: [], singlePhotos: [], ownerPhotos: [], ownerPhotoFail: false, captions: [], fail: null, quietAfterOne: false, failAt: null, dropToken: null, photoFail: null }; // fail: 'network' | 'refuse' (یک‌بار، برای پیام گروه)
const owner = []; const answers = []; const edits = []; const alerts = [];
globalThis.fetch = async (u, o) => {
  const method = String(u).split("/").pop();
  const b = o && o.body ? JSON.parse(o.body) : {};
  if (method === "answerCallbackQuery") { answers.push(b.text || ""); if (b.show_alert) alerts.push(b.text || ""); return ok(true); }
  if (method === "editMessageText") { edits.push(b); return ok(true); }
  if (method === "getChatMember") return ok({ status: "member" });
  if (String(b.chat_id) === "-1001") {
    // مثل تلگرام: آلبوم فقط ۲ تا ۱۰ عکس؛ تک‌عکس با sendPhoto
    if (method === "sendMediaGroup") { if (b.media.length < 2 || b.media.length > 10) return Response.json({ ok: false, error_code: 400, description: "Bad Request: wrong number of photos in media group" }, { status: 400 }); G.photos.push(b.media.length); return ok([{ message_id: ++mid }]); }
    if (method === "sendPhoto") {
      if (G.photoFail === "network") { G.photoFail = null; throw new Error("socket hang up"); }
      if (G.photoFail === "refuse") { G.photoFail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      G.singlePhotos.push(b.photo); G.captions.push(b.caption); return ok({ message_id: ++mid });
    }
    if (method === "sendMessage") {
      G.gc = (G.gc || 0) + 1;
      if (G.failAt && G.gc === G.failAt.n) { const k = G.failAt.kind; G.failAt = null; if (k === "network") throw new Error("socket hang up"); return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      if (G.fail === "network") { G.fail = null; throw new Error("socket hang up"); }
      if (G.fail === "parse" && b.parse_mode === "HTML") { G.fail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported tag" }, { status: 400 }); }
      if (G.fail === "refuse") { G.fail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      // محتوای ردشدنی در هر دو قالب (تست F2)
      if (G.dropToken && String(b.text).includes(G.dropToken)) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
      G.sent.push({ text: b.text, parse: b.parse_mode, id: ++mid });
      if (G.quietAfterOne) { G.quietAfterOne = false; clock.ms = Date.UTC(2026, 9, 14, 22, 30); } // 02:00 تهران، بعد از اولین پیام
      return ok({ message_id: mid });
    }
  }
  if (String(b.chat_id) === "5" && method === "sendMessage") { owner.push(b); return ok({ message_id: ++mid }); }
  if (String(b.chat_id) === "5" && method === "sendPhoto") { if (G.ownerPhotoFail) { G.ownerPhotoFail = false; return Response.json({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier" }, { status: 400 }); } G.ownerPhotos.push(b.photo); return ok({ message_id: ++mid }); }
  if (method === "sendMessage") return ok({ message_id: ++mid });
  return ok(true);
};

raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('group_id', '-1001')").run();
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-100999", INGEST_SECRET: "s", DB: db };
const W = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const { prepareBatch, expireBatches } = await import(WORKER + "src/batches.js");
const secret = await webhookSecret(env);
let uid = 60000;
const hook = (u) => W.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
const cbOwner = (data) => ({ update_id: ++uid, callback_query: { id: "cb" + uid, from: { id: 5 }, data, message: { message_id: 1, chat: { id: 5, type: "private" } } } });
const cbOther = (data) => ({ update_id: ++uid, callback_query: { id: "cb" + uid, from: { id: 77 }, data, message: { message_id: 1, chat: { id: 77, type: "private" } } } });
const ownerDm = (text) => ({ update_id: ++uid, message: { message_id: ++uid, chat: { id: 5, type: "private" }, from: { id: 5 }, text, date: 1 } });
const q1 = (sql, ...a) => raw.prepare(sql).get(...a);
const qN = (sql, ...a) => raw.prepare(sql).all(...a);
let postSeq = 0;
const addPost = (channel, text, img = "") => raw.prepare("INSERT INTO posts (source, channel, post_id, text, image_url, first_seen_utc) VALUES (?, ?, ?, ?, ?, ?)")
  .run(channel.split(":")[0], channel.split(":")[1], `p${++postSeq}`, text, img, Math.floor(clock.ms / 1000) + postSeq);
const batchOf = (postText) => q1("SELECT bi.batch_id AS b FROM scrape_batch_items bi JOIN posts p ON p.id = bi.post_id WHERE p.text = ?", postText)?.b;
const unsent = () => q1("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").n;
const batchState = (id) => q1("SELECT state FROM scrape_batches WHERE id = ?", id)?.state;
const ids = (bid) => qN("SELECT post_id FROM scrape_batch_items WHERE batch_id = ?", bid).map((r) => r.post_id);
const reset = () => { G.sent.length = 0; G.photos.length = 0; G.singlePhotos.length = 0; G.ownerPhotos.length = 0; owner.length = 0; answers.length = 0; };

let fails = 0; const T = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

// A) هیچ پست جدیدی → دسته‌ای ساخته نمی‌شه
reset(); let r = await prepareBatch(env);
T("A no new posts: no batch, no owner message", r.prepared === 0 && owner.length === 0 && !q1("SELECT 1 AS x FROM scrape_batches"));

// B) ساخت دسته: پست بله جانک کنار گذاشته می‌شه؛ پیش‌نمایش با دکمه
addPost("telegram:test_channel_a", "عنوان اول\n" + "متن بلند ".repeat(40));
addPost("telegram:test_channel_a", "پست کوتاه");
addPost("bale:test_channel_b", "۶۵ ۷:۴۳");
addPost("bale:test_channel_b", "اطلاعیه بله امتحان");
addPost("bale:test_channel_c", "عکس دار", "https://img.example/a.jpg");
reset(); r = await prepareBatch(env);
const B1 = r.batch;
T("B prepare creates one pending batch with 4 real posts (junk excluded)", r.prepared === 4 && batchState(B1) === "pending" && ids(B1).length === 4);
T("B junk bale row marked sent, not offered", q1("SELECT sent_at_utc AS s FROM posts WHERE text = '۶۵ ۷:۴۳'").s !== null);
const lastPreview = owner.filter((m) => m.reply_markup).at(-1);
T("B preview to owner has approve and reject buttons for this batch", lastPreview && lastPreview.reply_markup.inline_keyboard[0].map((b) => b.callback_data).join() === `sb:s:${B1},sb:r:${B1}`);

// C) دوباره اجرا: پست تازه‌ای نیست → دسته‌ی جدید نیست
reset(); r = await prepareBatch(env);
T("C no duplicate batch for already-offered posts", r.prepared === 0 && qN("SELECT id FROM scrape_batches").length === 1);

// D) اجرای هم‌زمان دو prepare: هر پست فقط یک دسته
addPost("telegram:test_channel_a", "هم‌زمان الف");
addPost("telegram:test_channel_a", "هم‌زمان ب");
await Promise.all([prepareBatch(env), prepareBatch(env)]);
const dItems = qN("SELECT post_id, COUNT(*) AS c FROM scrape_batch_items GROUP BY post_id");
T("D concurrent prepares: each post in exactly one batch", dItems.every((x) => x.c === 1) && dItems.length === 6);
const D1 = batchOf("هم‌زمان الف");

// E) تأیید مالک: ارسال به گروه، پست‌ها ارسال‌شده، عکس، و قالب
reset();
const eRes = await hook(cbOwner(`sb:s:${B1}`));
T("E owner approve: 200 and batch sent", eRes.status === 200 && batchState(B1) === "sent");
T("E all posts of batch marked sent", ids(B1).every((id) => q1("SELECT sent_at_utc AS s FROM posts WHERE id = ?", id).s !== null));
// برچسب کانال از CHANNEL_LABELS می‌آد؛ کانال‌های تست ناشناخته‌اند و خود کلید به‌عنوان برچسب می‌آد
T("E group got text messages (channel header + posts)", G.sent.length >= 1 && G.sent.some((m) => m.text.includes("telegram:test_channel_a")) && G.sent.some((m) => m.text.includes("bale:test_channel_b")));
T("E format: long post in expandable blockquote, first line bold", G.sent.some((m) => m.text.includes('<blockquote expandable><b>عنوان اول</b>')));
T("E single photo sent via sendPhoto once (no one-item album)", G.singlePhotos.length === 1 && G.photos.length === 0);
T("E answer shows result", answers.some((t) => t.includes("ارسال شد")));

// F) دوبار کلیک هم‌زمان روی همان دسته: هر بخش یک بار
reset();
const F_before = G.sent.length;
await Promise.all([hook(cbOwner(`sb:s:${D1}`)), hook(cbOwner(`sb:s:${D1}`))]);
const dUnits = new Set(qN("SELECT unit FROM scrape_batch_items WHERE batch_id = ?", D1).map((x) => x.unit));
T(`F double approve: exactly one group message per unit (units=${dUnits.size}, sent=${G.sent.length - F_before})`, G.sent.length - F_before === dUnits.size && batchState(D1) === "sent");

// G) توقف ارسال: تأیید رد می‌شه، دسته pending می‌مونه
addPost("telegram:test_channel_a", "پست توقف");
await prepareBatch(env); const G1 = batchOf("پست توقف");
raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scrape_paused', '1')").run();
reset(); await hook(cbOwner(`sb:s:${G1}`));
T("G paused: approval refused, nothing sent, batch still pending", G.sent.length === 0 && batchState(G1) === "pending" && answers.some((t) => t.includes("متوقف")));
raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scrape_paused', '0')").run();

// H) ساعت سکوت: تأیید رد می‌شه
atTehranHour(3); reset(); await hook(cbOwner(`sb:s:${G1}`));
T("H quiet hours: approval refused, nothing sent", G.sent.length === 0 && batchState(G1) === "pending" && answers.some((t) => t.includes("سکوت")));
atTehranHour(12);

// I) رد کردن: پست‌ها دیگه پیشنهاد نمی‌شن
addPost("telegram:test_channel_a", "پست رد");
await prepareBatch(env); const I1 = batchOf("پست رد");
reset(); await hook(cbOwner(`sb:r:${I1}`));
T("I reject: batch rejected, posts marked sent, nothing sent to group", batchState(I1) === "rejected" && G.sent.length === 0 && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'پست رد'").s !== null);
r = await prepareBatch(env);
T("I rejected posts are not re-offered", r.prepared === 0);

// I2) نتیجه‌ی رد زیر پیش‌نمایش نوشته می‌شه و دکمه‌ها برداشته می‌شن (بدون پنجره‌ی هشدار)
addPost("telegram:test_channel_a", "پست نتیجه");
await prepareBatch(env); const I2 = batchOf("پست نتیجه");
reset(); edits.length = 0; alerts.length = 0;
await hook({ update_id: ++uid, callback_query: { id: "cb" + uid, from: { id: 5 }, data: `sb:r:${I2}`, message: { message_id: 77, chat: { id: 5, type: "private" }, text: "پیش‌نمایش تست" } } });
T("I2 reject edits preview with result and no keyboard", edits.length === 1 && edits[0].message_id === 77 && edits[0].text.startsWith("پیش‌نمایش تست") && edits[0].text.includes("نتیجه:") && !edits[0].reply_markup);
T("I2 reject answers callback without alert", answers.length === 1 && alerts.length === 0);

// J) انقضا: دسته‌ی بی‌جواب آزاد می‌شه و دوباره پیشنهاد می‌شه؛ تأیید دیرهنگام رد می‌شه
addPost("telegram:test_channel_a", "پست انقضا");
await prepareBatch(env); const J1 = batchOf("پست انقضا");
clock.ms += 13 * 3600 * 1000; reset();
const exp = await expireBatches(env);
T("J expiry: batch expired, items released, owner told", exp.expired >= 1 && batchState(J1) === "expired" && batchOf("پست انقضا") === undefined && owner.some((m) => m.text.includes(`دسته‌ی ${J1} بی‌جواب`)));
reset(); await hook(cbOwner(`sb:s:${J1}`));
T("J late approval of expired batch: refused, nothing sent", G.sent.length === 0 && batchState(J1) === "expired");
r = await prepareBatch(env);
const J2 = batchOf("پست انقضا");
T("J expired post offered again in a new batch", r.prepared >= 1 && J2 && J2 !== J1 && batchState(J2) === "pending");
atTehranHour(12);

// K) نامشخص وسط ارسال: بخش اول ارسال، بخش دوم نامشخص → needs_review، بدون ارسال مجدد
const longA = "الف ".repeat(700), longB = "ب ".repeat(700), longC = "ج ".repeat(700);
addPost("telegram:test_channel_a", longA); addPost("bale:test_channel_b", longB); addPost("bale:test_channel_c", longC);
await prepareBatch(env); const K1 = batchOf(longA);
reset(); G.fail = null;
// پیام دوم گروه شبکه‌ای می‌شه: اولین بخش رفته، دومی نامشخص
let sentBefore = G.sent.length;
const origSend = G.sent.push.bind(G.sent);
let calls = 0; G.fail = "pending";
const kUpd = cbOwner(`sb:s:${K1}`);
// فعال‌سازی خطا بعد از اولین پیام گروه
const hookFail = () => { calls = 0; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (String(u).endsWith("/sendMessage") && o && JSON.parse(o.body).chat_id === "-1001") {
    calls++;
    if (calls === 2) throw new Error("socket hang up");
  }
  return realFetch(u, o);
};
await hook(kUpd);
globalThis.fetch = realFetch;
const K_units = new Set(qN("SELECT unit FROM scrape_batch_items WHERE batch_id = ? AND unit IS NOT NULL", K1).map((x) => x.unit));
T(`K plan: long posts split into >1 units (units=${K_units.size})`, K_units.size >= 2);
const kUpdRow = q1("SELECT state, reason FROM update_queue WHERE update_id = ?", kUpd.update_id);
T("K ambiguous unit: update needs_review(ambiguous)", kUpdRow && kUpdRow.state === "needs_review" && kUpdRow.reason === "ambiguous");
const kSent = ids(K1).filter((id) => q1("SELECT sent_at_utc AS s FROM posts WHERE id = ?", id).s !== null).length;
T(`K first unit sent, not all (sent posts=${kSent}/${ids(K1).length})`, kSent >= 1 && kSent < ids(K1).length);
T("K group got exactly one message before the ambiguous one", G.sent.length - sentBefore === 1);
// مالک: اثر انجام‌شده → بخش نامشخص بسته، پست‌هاش ارسال‌شده، بدون ارسال مجدد
reset(); await hook(ownerDm(`/resolve_update ${kUpd.update_id} applied`));
T("K owner applied: unit posts marked sent, nothing re-sent", ids(K1).every((id) => q1("SELECT sent_at_utc AS s FROM posts WHERE id = ?", id).s !== null) && G.sent.length === 0);

// L) نامشخص + not_applied → retry فقط بخش‌های باقی‌مانده، بدون تکرار
addPost("telegram:test_channel_a", longA + "۲"); addPost("bale:test_channel_b", longB + "۲"); addPost("bale:test_channel_c", longC + "۲");
await prepareBatch(env); const L1 = batchOf(longA + "۲");
const Lu = cbOwner(`sb:s:${L1}`);
calls = 0; globalThis.fetch = async (u, o) => { if (String(u).endsWith("/sendMessage") && o && JSON.parse(o.body).chat_id === "-1001") { calls++; if (calls === 2) throw new Error("socket hang up"); } return realFetch(u, o); };
reset(); await hook(Lu);
globalThis.fetch = realFetch;
const Lunits = new Set(qN("SELECT unit FROM scrape_batch_items WHERE batch_id = ? AND unit IS NOT NULL", L1).map((x) => x.unit)).size;
const sentFirst = G.sent.length;
await hook(ownerDm(`/resolve_update ${Lu.update_id} not_applied`));
reset(); await hook(ownerDm(`/retry_update ${Lu.update_id}`));
const allL = ids(L1).every((id) => q1("SELECT sent_at_utc AS s FROM posts WHERE id = ?", id).s !== null);
T(`L retry after not_applied: remaining units sent once (first run sent ${sentFirst}, retry sent ${G.sent.length}, units=${Lunits})`, allL && sentFirst + G.sent.length === Lunits && batchState(L1) === "sent");

// M) شکست قطعی تلگرام (refuse): هیچ اثری نیست؛ تلاش بعدی همان را می‌فرسته
addPost("telegram:test_channel_a", "پست رد شده قطعی"); await prepareBatch(env); const M1 = batchOf("پست رد شده قطعی");
reset(); G.fail = "refuse";
const mUpd = cbOwner(`sb:s:${M1}`);
const mRes = await hook(mUpd);
T("M refused by Telegram: update failed (500) and no post marked sent", mRes.status === 500 && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'پست رد شده قطعی'").s === null);
const mRes2 = await hook(mUpd);
T("M retry sends once and marks sent", mRes2.status === 200 && G.sent.length === 1 && batchState(M1) === "sent");

// N) /scrape_resume (بدون all) دسته‌های منتظر را رد می‌کنه
addPost("telegram:test_channel_a", "پست ریست"); await prepareBatch(env); const N1 = batchOf("پست ریست");
// /scrape_resume فقط از حالت توقف کار می‌کند (از همان سرویس پنل)؛ پس اول توقف
await hook(ownerDm("/scrape_pause"));
reset(); await hook(ownerDm("/scrape_resume"));
T("N resume from stop rejects pending batch and skips its posts", batchState(N1) === "rejected" && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'پست ریست'").s !== null);

// O) دکمه‌ی غیرمالک: بی‌صدا، هیچ تغییری نیست
addPost("telegram:test_channel_a", "پست غیرمالک"); await prepareBatch(env); const O1 = batchOf("پست غیرمالک");
reset(); await hook(cbOther(`sb:s:${O1}`));
T("O non-owner button: silent, batch untouched", G.sent.length === 0 && batchState(O1) === "pending" && owner.length === 0);

// P) محتوای خراب (تگ نامعتبر در HTML): با متن ساده فرستاده می‌شه و صف جلو می‌ره
addPost("telegram:test_channel_a", "پست <خراب> و بد"); await prepareBatch(env); const P1 = batchOf("پست <خراب> و بد");
reset(); G.fail = "parse";
await hook(cbOwner(`sb:s:${P1}`));
// فال‌بک متن ساده: تگ خام فقط در پیام متن ساده (بدون parse) می‌آد؛ هیچ پیام HTML حاوی تگ خام نیست
T("P HTML parse error: post delivered as plain text, no raw tag in HTML mode, queue advances", batchState(P1) === "sent" && G.sent.some((m) => m.text.includes("خراب") && !m.parse) && !G.sent.some((m) => m.parse === "HTML" && m.text.includes("<خراب>")) && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'پست <خراب> و بد'").s !== null);

// Q) توقف: ورود پست جدید دسته نمی‌سازه
reset(); await hook(ownerDm("/scrape_pause"));
const nb0 = q1("SELECT COUNT(*) AS n FROM scrape_batches").n;
addPost("telegram:test_channel_a", "پست وقتی متوقفه");
const Qr = await prepareBatch(env);
T("Q paused: prepareBatch skips, no batch created", Qr.skipped === "paused" && q1("SELECT COUNT(*) AS n FROM scrape_batches").n === nb0 && !batchOf("پست وقتی متوقفه"));

// R) /scrape_resume all: معوق‌ها در پیش‌نمایش بعدی می‌آین و علامت نمی‌خورن
reset(); await hook(ownerDm("/scrape_resume all"));
const Rb = await prepareBatch(env); const R1 = batchOf("پست وقتی متوقفه");
T("R resume all: backlog offered in a batch, not marked sent", !!R1 && batchState(R1) === "pending" && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'پست وقتی متوقفه'").s === null);
reset(); await hook(cbOwner(`sb:s:${R1}`));
T("R approved backlog post reaches group", G.sent.some((m) => m.text.includes("پست وقتی متوقفه")) && batchState(R1) === "sent");

// S) escape: کاراکترهای HTML در متن خام درست escape می‌شن
addPost("telegram:test_channel_a", "متن با <b>تگ</b> و A & B");
await prepareBatch(env); const S1 = batchOf("متن با <b>تگ</b> و A & B");
reset(); await hook(cbOwner(`sb:s:${S1}`));
T("S raw HTML in post is escaped when sent", G.sent.some((m) => m.parse === "HTML" && m.text.includes("&lt;b&gt;تگ&lt;/b&gt;") && m.text.includes("A &amp; B")) && !G.sent.some((m) => m.text.includes("<b>تگ</b>")));

// T) پست خیلی بلند: هیچ پیامی از سقف تلگرام (۴۰۹۶) رد نمی‌شه، دسته تموم می‌شه
addPost("telegram:test_channel_a", "بلند ".repeat(1500));
await prepareBatch(env); const T1 = qN("SELECT bi.batch_id AS b FROM scrape_batch_items bi JOIN posts p ON p.id = bi.post_id WHERE p.text LIKE 'بلند %' ORDER BY bi.batch_id DESC LIMIT 1")[0];
reset(); await hook(cbOwner(`sb:s:${T1.b}`));
T("T too-long post: every message within 4096, batch sent", G.sent.length > 0 && G.sent.every((m) => m.text.length <= 4096) && batchState(T1.b) === "sent");

// ---- بررسی ادعاها (۱ تا ۵)
// آماده‌سازی: صف قبلی تمیز شود تا این بخش فقط پست‌های خودش را ببیند
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
raw.exec("UPDATE scrape_batches SET state = 'rejected' WHERE state = 'pending'");
atTehranHour(12);

// ۱) دو تأیید هم‌زمان: هر پست فقط یک بار منتشر می‌شه
addPost("telegram:test_channel_a", "ادعا۱ پست یکتا");
await prepareBatch(env); const C1 = batchOf("ادعا۱ پست یکتا");
reset();
const [c1a, c1b] = await Promise.all([hook(cbOwner(`sb:s:${C1}`)), hook(cbOwner(`sb:s:${C1}`))]);
const c1count = G.sent.filter((m) => m.text.includes("ادعا۱ پست یکتا")).length;
T(`ادعا۱ double approve concurrent: exactly one publish (count=${c1count})`, c1count === 1 && batchState(C1) === "sent");

// ۲) دسته‌ی منقضی‌شده (یا ردشده) نمی‌تونه پست‌های واگذارشده به دسته‌ی جدید رو منتشر کنه
addPost("telegram:test_channel_a", "ادعا۲ واگذاری");
await prepareBatch(env); const D_A = batchOf("ادعا۲ واگذاری");
clock.ms += 13 * 3600e3; // بیش از ۱۲ ساعت: دسته‌ی A منقضی
const exA = await expireBatches(env);
await prepareBatch(env); const D_B = batchOf("ادعا۲ واگذاری");
T("ادعا۲ setup: A expired, post reassigned to new batch B", exA.expired >= 1 && batchState(D_A) === "expired" && D_B && D_B !== D_A);
reset(); await hook(cbOwner(`sb:s:${D_A}`));
T("ادعا۲ stale callback of expired A: refused, nothing published, B still pending", G.sent.length === 0 && batchState(D_B) === "pending" && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'ادعا۲ واگذاری'").s === null);
reset(); await hook(cbOwner(`sb:s:${D_B}`));
T("ادعا۲ approve B publishes once", G.sent.filter((m) => m.text.includes("ادعا۲ واگذاری")).length === 1 && batchState(D_B) === "sent");
atTehranHour(12);

// ۳) شکست وسط ارسال: بخش‌های موفق قبلی تکرار نمی‌شن؛ applied فقط بخش بررسی‌شده را sent می‌کنه
const e3 = Array.from({ length: 3 }, (_, i) => `ادعا۳ بخش${i} ` + "متن ".repeat(700));
e3.forEach((t) => addPost("telegram:test_channel_a", t));
await prepareBatch(env); const E_B = batchOf(e3[0]);
reset(); G.gc = 0; G.failAt = { n: 2, kind: "network" }; // بخش دوم: نتیجه نامشخص
const eUpd = cbOwner(`sb:s:${E_B}`);
const eRes3 = await hook(eUpd);
const eSent = (t) => q1("SELECT sent_at_utc AS s FROM posts WHERE text = ?", t).s !== null;
T("ادعا۳ ambiguous mid-send: update needs_review, unit1 sent, unit2 & unit3 not", eRes3.status === 200 && G.sent.length === 1 && eSent(e3[0]) && !eSent(e3[1]) && !eSent(e3[2]));
const eUpdId = q1("SELECT update_id AS u FROM update_queue WHERE state = 'needs_review' ORDER BY update_id DESC LIMIT 1").u;
reset(); await hook(ownerDm(`/resolve_update ${eUpdId} applied`));
T("ادعا۳ owner applied: only reviewed unit2 marked sent; unit3 still unsent; nothing re-sent", eSent(e3[1]) && !eSent(e3[2]) && G.sent.length === 0 && eSent(e3[0]));
const E_units = new Set(qN("SELECT unit FROM scrape_batch_items WHERE batch_id = ? AND unit IS NOT NULL", E_B).map((x) => x.unit));
T(`ادعا۳ plan: batch split into 3 units after first approval (units=${E_units.size})`, E_units.size === 3);
reset(); await hook(cbOwner(`sb:s:${E_B}`));
T("ادعا۳ approve again: only unit3 published; no earlier unit repeated", G.sent.length === 1 && G.sent[0].text.includes("ادعا۳ بخش2") && eSent(e3[2]) && batchState(E_B) === "sent");

// ۳ب) شکست قطعی (refuse) وسط ارسال: بخش اول تکرار نمی‌شه؛ تلاش دوباره فقط بقیه را می‌فرسته
const e3b = Array.from({ length: 3 }, (_, i) => `ادعا۳ب بخش${i} ` + "متن ".repeat(700));
e3b.forEach((t) => addPost("telegram:test_channel_a", t));
await prepareBatch(env); const EB_B = batchOf(e3b[0]);
reset(); G.gc = 0; G.failAt = { n: 2, kind: "refuse" };
const ebRes = await hook(cbOwner(`sb:s:${EB_B}`));
const ebSent = (t) => q1("SELECT sent_at_utc AS s FROM posts WHERE text = ?", t).s !== null;
T("ادعا۳ب refused mid-send: update failed (500), unit1 sent, unit2 & unit3 not", ebRes.status === 500 && G.sent.length === 1 && ebSent(e3b[0]) && !ebSent(e3b[1]) && !ebSent(e3b[2]));
reset(); const ebRes2 = await hook(cbOwner(`sb:s:${EB_B}`));
T("ادعا۳ب retry: unit2 and unit3 published once each; unit1 not repeated", ebRes2.status === 200 && G.sent.length === 2 && G.sent.every((m) => !m.text.includes("ادعا۳ب بخش0")) && ebSent(e3b[1]) && ebSent(e3b[2]) && batchState(EB_B) === "sent");

// ۵) ساعت سکوت: تأیید مالک ارسال فوری نمی‌کنه، دسته pending می‌مونه
addPost("telegram:test_channel_a", "ادعا۵ سکوت");
await prepareBatch(env); const F_B = batchOf("ادعا۵ سکوت");
atTehranHour(3);
reset(); await hook(cbOwner(`sb:s:${F_B}`));
T("ادعا۵ owner approve in quiet hours: nothing sent, still pending", G.sent.length === 0 && batchState(F_B) === "pending");
atTehranHour(12);

// ===== بازتولید گیرکردن دسته در sending و ثبت نتیجه (Z1..Z3)
const T_ON_TEHRAN_NEXT_MORNING = () => { clock.ms = Date.UTC(2026, 9, 14, 8, 30) + 19 * 3600e3; }; // 07:00 تهران، روز بعد (بیرون از سکوت)
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
raw.exec("UPDATE scrape_batches SET state = 'rejected' WHERE state = 'pending'");

// Z1) ارسال ناقص رها می‌شه؛ انقضا و prepare نباید گیرش رو بازکنن؛ مالک باید از /review به ادامه برسه
atTehranHour(12);
const z1 = Array.from({ length: 3 }, (_, i) => `زد۱ بخش${i} ` + "متن ".repeat(700));
z1.forEach((t) => addPost("telegram:test_channel", t));
await prepareBatch(env); const Z1_B = batchOf(z1[0]);
const z1Sent = (t) => q1("SELECT sent_at_utc AS s FROM posts WHERE text = ?", t).s !== null;
reset(); G.gc = 0; G.failAt = { n: 2, kind: "refuse" };
await hook(cbOwner(`sb:s:${Z1_B}`));
T_ON_TEHRAN_NEXT_MORNING();
await expireBatches(env); await prepareBatch(env);
T("Z1 stalled batch: stays sending, not expired, unsent posts not re-offered", batchState(Z1_B) === "sending" && !z1Sent(z1[1]) && !z1Sent(z1[2]) && batchOf(z1[1]) === Z1_B);
reset(); await hook(ownerDm("/review"));
const z1Review = owner.map((m) => JSON.stringify(m)).join("\n");
T("Z1 /review lists the stalled batch with a continue button", z1Review.includes(`sb:c:${Z1_B}`));
reset(); await hook(cbOwner(`sb:c:${Z1_B}`));
T("Z1 owner continue: only unsent units published once; first unit not repeated; batch sent", G.sent.length === 2 && G.sent.every((m) => !m.text.includes("زد۱ بخش0")) && z1Sent(z1[1]) && z1Sent(z1[2]) && batchState(Z1_B) === "sent");

// Z2) خطای نامشخص: انقضا و ادامه نباید واحد نامشخص را دوباره بفرستن؛ فقط owner applied آن را می‌بندد
atTehranHour(12);
const z2 = Array.from({ length: 3 }, (_, i) => `زد۲ بخش${i} ` + "متن ".repeat(700));
z2.forEach((t) => addPost("telegram:test_channel", t));
await prepareBatch(env); const Z2_B = batchOf(z2[0]);
const z2Sent = (t) => q1("SELECT sent_at_utc AS s FROM posts WHERE text = ?", t).s !== null;
reset(); G.gc = 0; G.failAt = { n: 2, kind: "network" };
await hook(cbOwner(`sb:s:${Z2_B}`));
const z2Upd = q1("SELECT update_id AS u FROM update_queue WHERE state = 'needs_review' ORDER BY update_id DESC LIMIT 1").u;
clock.ms += 200 * 1000; // intent کهنه؛ نتیجه نامشخص می‌مونه
reset(); await hook(cbOwner(`sb:c:${Z2_B}`));
T("Z2 continue with ambiguous unit: unit2 not re-sent, unit3 sent, batch still sending", G.sent.length === 1 && G.sent[0].text.includes("زد۲ بخش2") && !z2Sent(z2[1]) && batchState(Z2_B) === "sending");
T_ON_TEHRAN_NEXT_MORNING(); await expireBatches(env);
T("Z2 expiry does not release a sending batch with ambiguous unit", batchState(Z2_B) === "sending" && !z2Sent(z2[1]));
reset(); await hook(ownerDm(`/resolve_update ${z2Upd} applied`));
reset(); await hook(cbOwner(`sb:c:${Z2_B}`));
T("Z2 after owner applied: ambiguous unit closed without resend; batch sent", z2Sent(z2[1]) && G.sent.length === 0 && batchState(Z2_B) === "sent");

// Z3) ارسال موفق ولی ثبت نتیجه شکست بخوره: پست نباید sent شود؛ update باید needs_review(ambiguous) شود
atTehranHour(12);
addPost("telegram:test_channel", "زد۳ پست یک‌بخشی");
await prepareBatch(env); const Z3_B = batchOf("زد۳ پست یک‌بخشی");
reset(); G.gc = 0; G.failAt = null;
chk = (sql) => { if (sql.includes("state = 'done', msg_id")) throw new Error("D1 write failed"); };
const z3Res = await hook(cbOwner(`sb:s:${Z3_B}`));
chk = null;
const z3Row = q1("SELECT state, reason FROM update_queue WHERE update_id = (SELECT MAX(update_id) FROM update_queue)");
T("Z3 send ok but result write fails: post not marked sent; update needs_review(ambiguous)", G.sent.length === 1 && q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'زد۳ پست یک‌بخشی'").s === null && z3Row && z3Row.state === "needs_review" && z3Row.reason === "ambiguous");

// Z4) /scrape_status: تأیید ربات و کنار گذاشته‌شده جدا از sent؛ تعداد از جدول نتیجه
reset(); await hook(ownerDm("/scrape_status"));
const z4Delivered = q1("SELECT COUNT(*) AS n FROM post_outcomes WHERE outcome = 'delivered'").n;
const z4Text = owner.map((m) => m.text).join("\n");
T(`Z4 status: delivered count is from outcomes (${z4Delivered}), separate from set-aside`, z4Text.includes(`تأیید ربات (در گروه): ${z4Delivered}`) && z4Text.includes("کنار گذاشته‌شده:"));

// Z5) ادامه‌ی دسته فقط مالک و خارج از سکوت؛ هیچ مسیری بدون مالک یا در سکوت به گروه نمی‌فرسته
atTehranHour(12);
const z5 = Array.from({ length: 3 }, (_, i) => `زد۵ بخش${i} ` + "متن ".repeat(700));
z5.forEach((t) => addPost("telegram:test_channel", t));
await prepareBatch(env); const Z5_B = batchOf(z5[0]);
reset(); G.gc = 0; G.failAt = { n: 2, kind: "refuse" };
await hook(cbOwner(`sb:s:${Z5_B}`));
reset(); await hook(cbOther(`sb:c:${Z5_B}`));
T("Z5 non-owner continue: silent, nothing sent", G.sent.length === 0 && batchState(Z5_B) === "sending");
atTehranHour(3); reset(); await hook(cbOwner(`sb:c:${Z5_B}`));
T("Z5 owner continue in quiet hours: refused, nothing sent", G.sent.length === 0 && batchState(Z5_B) === "sending" && answers.some((t) => t.includes("سکوت")));
atTehranHour(12); reset(); await hook(cbOwner(`sb:c:${Z5_B}`));
T("Z5 owner continue at noon: remaining units sent once", G.sent.length === 2 && batchState(Z5_B) === "sent");

// ===== بازتولید و اصلاح بازبینی مستقل (Y1..Y6)
const onlyBatchOf = (text) => batchOf(text);
// Y1 (F1): fallback یک‌واحدی؛ موفقیت قبلی در retry تکرار نمی‌شه
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
raw.exec("UPDATE scrape_batches SET state = 'rejected' WHERE state = 'pending'");
atTehranHour(12);
addPost("telegram:test_channel_a", "y1 POST_ONE alpha"); addPost("telegram:test_channel_a", "y1 POST_TWO beta");
await prepareBatch(env); const Y1 = batchOf("y1 POST_ONE alpha");
reset(); G.gc = 0; G.fail = "parse"; G.failAt = { n: 2, kind: "refuse" };
const y1a = await hook(cbOwner(`sb:s:${Y1}`));
const y1Copies = () => G.sent.filter((m) => m.text.includes("y1 POST_ONE")).length;
T("Y1 HTML refused then plain refused: nothing delivered, update failed (500)", y1a.status === 500 && y1Copies() === 0);
reset(); const y1b = await hook(cbOwner(`sb:s:${Y1}`));
T("Y1 retry: POST_ONE delivered exactly once", y1b.status === 200 && y1Copies() === 1 && batchState(Y1) === "sent");

// Y2 (F2): محتوای ردشده در هر دو قالب، delivered نمی‌شه؛ بقیه‌ی واحد می‌رسن
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
addPost("telegram:test_channel_a", "y2 OK-ONE"); addPost("telegram:test_channel_a", "y2 DROP-THIS-POST");
await prepareBatch(env); const Y2 = batchOf("y2 OK-ONE");
reset(); G.dropToken = "DROP-THIS-POST";
const y2res = await hook(cbOwner(`sb:s:${Y2}`));
G.dropToken = null;
const y2Out = (t) => q1("SELECT outcome FROM post_outcomes o JOIN posts p ON p.id = o.post_id WHERE p.text = ?", t)?.outcome;
T("Y2 refused content: not delivered (telegram_refused), sibling post delivered, batch sent", y2res.status === 200 && y2Out("y2 DROP-THIS-POST") === "telegram_refused" && y2Out("y2 OK-ONE") === "delivered" && batchState(Y2) === "sent");
T("Y2 refused post never appears as delivered message", !G.sent.some((m) => m.text.includes("DROP-THIS-POST") && !m.text.includes("نپذیرفت")) && G.sent.some((m) => m.text.includes("y2 OK-ONE")));

// Y4 (F4): عکس مبهم بعد از موفقیت متن، در /review و ادامه قابل بازیابی؛ بدون تصمیم مالک تکرار نمی‌شه
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
addPost("telegram:test_channel_a", "y4 with photo"); raw.exec("UPDATE posts SET image_url = 'https://img.example/y4.jpg' WHERE text = 'y4 with photo'");
await prepareBatch(env); const Y4 = batchOf("y4 with photo");
reset(); G.photoFail = "network";
await hook(cbOwner(`sb:s:${Y4}`));
const y4Upd = q1("SELECT update_id AS u FROM update_queue WHERE state = 'needs_review' ORDER BY update_id DESC LIMIT 1")?.u;
T("Y4 caption photo ambiguous: text not sent separately; batch stays sending; update needs_review(ambiguous)", !G.sent.some((m) => m.text.includes("y4 with photo")) && batchState(Y4) === "sending" && y4Upd);
reset(); await hook(ownerDm("/review"));
T("Y4 /review shows stalled batch with photo count and continue button", owner.map((m) => JSON.stringify(m)).join("\n").includes(`sb:c:${Y4}`));
clock.ms += 200 * 1000;
reset(); await hook(cbOwner(`sb:c:${Y4}`));
T("Y4 continue before owner decision: ambiguous photo not resent", G.singlePhotos.length === 0 && batchState(Y4) === "sending");
reset(); await hook(ownerDm(`/resolve_update ${y4Upd} not_applied`));
reset(); await hook(cbOwner(`sb:c:${Y4}`));
T("Y4 after owner not_applied: photo sent once by continue; batch sent; texts not repeated", G.singlePhotos.length === 1 && G.sent.length === 0 && batchState(Y4) === "sent");

// Y6c) پست تنها عکس با متن کوتاه: متن زیر عکس، بدون پیام متنی جدا، و پست ارسال‌شده ثبت می‌شه
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
addPost("telegram:test_channel_a", "caption ok"); raw.exec("UPDATE posts SET image_url = 'https://img.example/cap.jpg' WHERE text = 'caption ok'");
await prepareBatch(env); const YC = batchOf("caption ok");
reset(); G.captions.length = 0;
await hook(cbOwner(`sb:s:${YC}`));
T("Y6c caption: photo carries post text as caption", G.captions.includes("caption ok") && G.singlePhotos.length === 1);
T("Y6c caption: no separate text message for that post", !G.sent.some((m) => m.text.includes("caption ok")));
T("Y6c caption: post marked sent and batch sent", q1("SELECT sent_at_utc AS s FROM posts WHERE text = 'caption ok'").s !== null && batchState(YC) === "sent");

// Y7) پیش‌نمایش مالک: عکس پست در پیوی مالک هم دیده شود، و دکمه‌ها همچنان زیر متن بیایند
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
addPost("telegram:test_channel_a", "preview photo"); raw.exec("UPDATE posts SET image_url = 'https://img.example/pv.jpg' WHERE text = 'preview photo'");
reset();
await prepareBatch(env);
T("Y7 preview: batch photo is shown to the owner", G.ownerPhotos.includes("https://img.example/pv.jpg"));
T("Y7 preview: text preview with approve button still sent", owner.some((m) => m.reply_markup && JSON.stringify(m.reply_markup).includes("sb:s:")));

// Y7b) عکس پیش‌نمایش خراب: متن پیش‌نمایش و دکمه‌ها همچنان می‌آیند
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
addPost("telegram:test_channel_a", "preview bad photo"); raw.exec("UPDATE posts SET image_url = 'https://img.example/bad.jpg' WHERE text = 'preview bad photo'");
reset(); G.ownerPhotoFail = true;
await prepareBatch(env);
T("Y7b preview photo refused: text preview with approve button still sent", owner.some((m) => m.reply_markup && JSON.stringify(m.reply_markup).includes("sb:s:")));
T("Y7b preview photo refused: owner gets a note naming the section and the reason", owner.some((m) => (m.text || "").startsWith("عکس «") && (m.text || "").includes("نرسید: ")));

// X) تلگرام: عکسِ تنها حفظ می‌شود، خالیِ بی‌عکس جنک است، و متن کوتاه همچنان ارسال می‌شود
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
const xImageUrl = "https://img.example/telegram-image-only.jpg";
addPost("telegram:test_channel_a", "", xImageUrl); const xImageId = `p${postSeq}`;
addPost("telegram:test_channel_a", "", ""); const xEmptyId = `p${postSeq}`;
addPost("telegram:test_channel_a", "x"); const xShortId = `p${postSeq}`;
reset();
const xPrepared = await prepareBatch(env);
const xPostLookupSql = "SELECT p.id, p.sent_at_utc AS sent, bi.batch_id AS batch FROM posts p LEFT JOIN scrape_batch_items bi ON bi.post_id = p.id WHERE p.source = 'telegram' AND p.channel = 'test_channel_a' AND p.post_id = ?";
const xPostLookupPlan = raw.prepare(`EXPLAIN QUERY PLAN ${xPostLookupSql}`).all(xImageId).map((row) => row.detail);
T("X test-only post/batch lookup uses the posts composite index without scanning posts", xPostLookupPlan.some((detail) => detail.includes("sqlite_autoindex_posts_1")) && !xPostLookupPlan.some((detail) => /\bSCAN p\b/.test(detail)));
const xImage = q1(xPostLookupSql, xImageId);
const xEmpty = q1(xPostLookupSql, xEmptyId);
const xShort = q1(xPostLookupSql, xShortId);
const xEmptyOutcome = xEmpty && q1("SELECT outcome FROM post_outcomes WHERE post_id = ?", xEmpty.id)?.outcome;
T("X image-only Telegram post stays in the batch with its image URL", xPrepared.prepared === 2 && xImage && xImage.sent === null && xImage.batch === xPrepared.batch && G.ownerPhotos.includes(xImageUrl));
T("X empty Telegram post without image is marked junk and excluded", xEmpty && xEmpty.sent !== null && xEmpty.batch === null && xEmptyOutcome === "junk");
T("X one-character Telegram text is not junk", xShort && xShort.sent === null && xShort.batch === xPrepared.batch);
reset();
const xApproved = await hook(cbOwner(`sb:s:${xPrepared.batch}`));
const xShortOutcome = xShort && q1("SELECT outcome FROM post_outcomes WHERE post_id = ?", xShort.id)?.outcome;
T("X approval sends image-only Telegram post through sendPhoto using image_url", xApproved.status === 200 && G.singlePhotos.includes(xImageUrl));
T("X approval still delivers the short Telegram text and completes the batch", xShortOutcome === "delivered" && batchState(xPrepared.batch) === "sent");

// Y5 (F5): سکوت وسط دسته؛ واحد بعدی نمی‌رسه، باقی‌مانده برای ادامه حفظ می‌شه
raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
atTehranHour(12);
const y5 = Array.from({ length: 3 }, (_, i) => `y5 بخش${i} ` + "متن ".repeat(700));
y5.forEach((t) => addPost("telegram:test_channel_a", t));
await prepareBatch(env); const Y5 = batchOf(y5[0]);
reset(); G.quietAfterOne = true;
await hook(cbOwner(`sb:s:${Y5}`));
T("Y5 quiet starts after first message: second message not sent, batch sending", G.sent.filter((m) => m.text.includes("y5 بخش")).length === 1 && batchState(Y5) === "sending");
atTehranHour(12); reset(); await hook(cbOwner(`sb:c:${Y5}`));
T("Y5 continue after quiet: remaining units sent once each", G.sent.length === 2 && batchState(Y5) === "sent");

// Y6 (F6): رقابت تأیید با رد و انقضا؛ بازنده هیچ پیامی نمی‌فرسته
for (const [label, to] of [["reject", "rejected"], ["expire", "expired"]]) {
  raw.exec("UPDATE posts SET sent_at_utc = 1 WHERE sent_at_utc IS NULL");
  atTehranHour(12);
  addPost("telegram:test_channel_a", `y6 ${label} race`);
  await prepareBatch(env); const Y6 = batchOf(`y6 ${label} race`);
  reset();
  let fired = false;
  chk = (sql) => { if (!fired && sql.startsWith("UPDATE scrape_batches SET state = 'sending'")) { fired = true; raw.prepare(`UPDATE scrape_batches SET state = '${to}' WHERE id = ? AND state = 'pending'`).run(Y6); } };
  await hook(cbOwner(`sb:s:${Y6}`));
  chk = null;
  T(`Y6 approve lost CAS to ${label}: nothing sent, batch stays ${to}`, fired && G.sent.length === 0 && batchState(Y6) === to);
}

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
