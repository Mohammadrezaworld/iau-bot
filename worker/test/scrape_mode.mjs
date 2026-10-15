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
const G = { sent: [], photos: [], singlePhotos: [], fail: null, quietAfterOne: false, failAt: null, dropToken: null, photoFail: null }; // fail: 'network' | 'refuse' (یک‌بار، برای پیام گروه)
const owner = []; const answers = [];
globalThis.fetch = async (u, o) => {
  const method = String(u).split("/").pop();
  const b = o && o.body ? JSON.parse(o.body) : {};
  if (method === "answerCallbackQuery") { answers.push(b.text || ""); return ok(true); }
  if (method === "getChatMember") return ok({ status: "member" });
  if (String(b.chat_id) === "-1001") {
    // مثل تلگرام: آلبوم فقط ۲ تا ۱۰ عکس؛ تک‌عکس با sendPhoto
    if (method === "sendMediaGroup") { if (b.media.length < 2 || b.media.length > 10) return Response.json({ ok: false, error_code: 400, description: "Bad Request: wrong number of photos in media group" }, { status: 400 }); G.photos.push(b.media.length); return ok([{ message_id: ++mid }]); }
    if (method === "sendPhoto") {
      if (G.photoFail === "network") { G.photoFail = null; throw new Error("socket hang up"); }
      if (G.photoFail === "refuse") { G.photoFail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      G.singlePhotos.push(b.photo); return ok({ message_id: ++mid });
    }
    if (method === "sendMessage") {
      G.gc = (G.gc || 0) + 1;
      if (G.failAt && G.gc === G.failAt.n) { const k = G.failAt.kind; G.failAt = null; if (k === "network") throw new Error("socket hang up"); return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      if (G.fail === "network") { G.fail = null; throw new Error("socket hang up"); }
      if (G.fail === "parse" && b.parse_mode === "HTML") { G.fail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported tag" }, { status: 400 }); }
      if (G.fail === "refuse") { G.fail = null; return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }); }
      // محتوای ردشدنی در هر دو قالب (تست F2)
      // HTML رد می‌شود و هم‌زمان ساعت وارد سکوت می‌شود (تلاش متن ساده بعد از آن)
      if (G.htmlThenQuiet && b.parse_mode === "HTML" && String(b.text).includes(G.htmlThenQuiet)) { G.htmlThenQuiet = null; clock.ms = Date.UTC(2026, 9, 15, 22, 30); return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 }); }
      if (G.dropToken && String(b.text).includes(G.dropToken)) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
      G.sent.push({ text: b.text, parse: b.parse_mode, id: ++mid });
      if (G.afterOne) { const f = G.afterOne; G.afterOne = null; f(); }
      if (G.quietAfterOne) { G.quietAfterOne = false; clock.ms = Date.UTC(2026, 9, 14, 22, 30); } // 02:00 تهران، بعد از اولین پیام
      return ok({ message_id: mid });
    }
  }
  if (String(b.chat_id) === "5" && method === "sendMessage") { owner.push(b); return ok({ message_id: ++mid }); }
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
const reset = () => { G.sent.length = 0; G.photos.length = 0; G.singlePhotos.length = 0; owner.length = 0; answers.length = 0; };

// آخرین دکمه‌ی مالک با این پیشوند (توکن تأیید خودکار)؛ باید قبل از reset() خوانده شود
const tokBtn = (prefix) => {
  for (let i = owner.length - 1; i >= 0; i--) {
    const kb = (owner[i].reply_markup && owner[i].reply_markup.inline_keyboard || []).flat();
    const f = kb.find((b) => String(b.callback_data).startsWith(prefix));
    if (f) return f.callback_data;
  }
  return prefix;
};
let fails = 0; const T = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

// ---- مرحله ۲: پنل حالت ارسال (تأیید دستی / ارسال خودکار / توقف انتشار)
// همه‌ی تغییرها از مسیر واقعی webhook (callback و پیام پیوی) می‌آین.
const tick = (sec = 60) => { clock.ms += sec * 1000; };
const setting = (k) => q1("SELECT value FROM settings WHERE key = ?", k)?.value;
const ownerTexts = () => owner.map((b) => b.text || "");
const panelSent = () => ownerTexts().some((t) => t.startsWith("تنظیمات ارسال خبرهای اسکرپ"));
const groupHas = (text) => G.sent.some((m) => String(m.text).includes(text));
const scrapeMode = async () => (await import(WORKER + "src/channels.js")).scrapeMode(env);
const stateOfPost = (text) => { const b = batchOf(text); return b ? batchState(b) : null; };
const sentAt = (text) => q1("SELECT sent_at_utc AS s FROM posts WHERE text = ?", text)?.s ?? null;
const outcomeOf = (text) => q1("SELECT o.outcome AS o FROM post_outcomes o JOIN posts p ON p.id = o.post_id WHERE p.text = ?", text)?.o ?? null;

// M0) پیش‌فرض: بدون تنظیم، تأیید دستی؛ و مسیر flushPosts قدیمی وجود ندارد
reset();
T("M0 default mode without setting is manual", (await scrapeMode()) === "manual" && setting("scrape_auto") === undefined);
{
  const { readFileSync: rf } = await import("fs");
  const src = ["src/index.js", "src/batches.js", "src/scrape_mode.js", "src/channels.js"].map((f) => rf(WORKER + f, "utf8")).join("\n");
  T("M0 no flushPosts reference in scrape paths", !/flushPosts/.test(src));
}

// M1) /scrape_settings در پیوی مالک: پنل با حالت فعلی
reset(); await hook(ownerDm("/scrape_settings"));
T("M1 owner /scrape_settings shows panel with current mode", panelSent() && ownerTexts().some((t) => t.includes("حالت فعلی: تأیید دستی")));

// M2) غیرمالک: نه پنل، نه تغییر حالت
reset();
await hook(cbOther("ss:autoy"));
await hook({ update_id: ++uid, message: { message_id: ++uid, chat: { id: 77, type: "private" }, from: { id: 77 }, text: "/scrape_settings", date: 1 } });
await hook(cbOther("ss:stop"));
T("M2 non-owner: no panel and no mode change", !panelSent() && (await scrapeMode()) === "manual" && setting("scrape_paused") !== "1");

// M3) ارسال خودکار: اولین دکمه فقط توضیح و تأیید دوم می‌دهد، حالت تغییر نمی‌کند
reset(); await hook(cbOwner("ss:auto"));
const m3 = owner.at(-1);
T("M3 auto first press asks second confirmation and does not switch", JSON.stringify(m3?.reply_markup || {}).includes("تأیید دوم") && (await scrapeMode()) === "manual");

// M4) تأیید دوم: حالت خودکار، زمان شروع، و ثبت audit
const a4 = tokBtn("ss:autoy:"); tick(); reset(); await hook(cbOwner(a4));
const auditRow = q1("SELECT action, detail FROM audit_log WHERE action = 'scrape_mode' ORDER BY id DESC LIMIT 1");
T("M4 second confirmation switches to auto with since and audit", (await scrapeMode()) === "auto" && !!setting("scrape_auto_since") && auditRow && auditRow.detail === "manual->auto");

// M5) خودکار: پست جدید بعد از فعال‌سازی بدون پیش‌نمایش به گروه می‌رود
reset(); addPost("telegram:test_channel_a", "پست خودکار جدید ۵");
await prepareBatch(env);
T("M5 auto: new post goes to group without preview", groupHas("پست خودکار جدید ۵") && !ownerTexts().some((t) => t.includes("پیش‌نمایش")) && sentAt("پست خودکار جدید ۵") !== null);

// M6) دسته‌ی منتظرِ قبل از تغییر به خودکار: پس از تغییر منتشر نمی‌شود
await hook(cbOwner("ss:manual")); // بدون توقف: مستقیم به تأیید دستی
tick(); reset(); addPost("telegram:test_channel_a", "پیش از خودکار ۶");
await prepareBatch(env); const M6b = batchOf("پیش از خودکار ۶");
T("M6 manual preview batch created before switch", batchState(M6b) === "pending");
tick(); reset(); await hook(cbOwner("ss:auto")); await hook(cbOwner(tokBtn("ss:autoy:")));
T("M6 pre-switch pending batch stays pending after auto switch", batchState(M6b) === "pending" && !groupHas("پیش از خودکار ۶") && sentAt("پیش از خودکار ۶") === null);
reset(); await hook(cbOwner(`sb:r:${M6b}`)); // پاکسازی: رد جداگانه
T("M6 pending batch needs separate reject", batchState(M6b) === "rejected");

// M7) توقف → خودکار با «پیشنهاد معوق‌ها»: معوق‌ها فقط پیش‌نمایش دستی، نه ارسال خودکار
await hook(cbOwner("ss:stop"));
tick(); reset(); addPost("telegram:test_channel_a", "معوق هفت ۷");
await prepareBatch(env);
T("M7 stop: backlog not prepared", batchOf("معوق هفت ۷") === undefined && sentAt("معوق هفت ۷") === null);
tick(); reset(); await hook(cbOwner("ss:auto"));
await hook(cbOwner(tokBtn("ss:go:auto:sug:")));
T("M7 stop→auto(suggest): backlog preview pending, not auto-sent", stateOfPost("معوق هفت ۷") === "pending" && !groupHas("معوق هفت ۷") && (await scrapeMode()) === "auto");

// M8) توقف: دسته‌ی منتظر و پست‌های جدید ارسال نمی‌شوند؛ تأیید دستی هم بسته است
await hook(cbOwner("ss:manual")); // از خودکار به تأیید دستی
tick(); reset(); addPost("telegram:test_channel_a", "منتظر هشت ۸"); await prepareBatch(env); const M8b = batchOf("منتظر هشت ۸");
await hook(cbOwner("ss:stop"));
tick(); reset(); addPost("telegram:test_channel_a", "جدید در توقف ۸"); await prepareBatch(env);
await hook(cbOwner(`sb:s:${M8b}`));
T("M8 stop: no fresh send, no manual approve of pending batch", !groupHas("منتظر هشت ۸") && !groupHas("جدید در توقف ۸") && batchState(M8b) === "pending" && stateOfPost("جدید در توقف ۸") === null);

// M9) خروج از توقف با «فقط پست‌های جدید»: معوق‌ها کنار گذاشته، دسته‌ی منتظر رد، بعد از آن پست جدید پیش‌نمایش دستی
reset(); await hook(cbOwner("ss:manual"));
T("M9 leaving stop asks for backlog choice", ownerTexts().some((t) => t.includes("پست‌های معوق چه شوند")));
tick(); reset(); await hook(cbOwner("ss:go:manual:new"));
T("M9 leave stop(new): backlog skipped, pending rejected, nothing sent", !groupHas("منتظر هشت ۸") && !groupHas("جدید در توقف ۸") && outcomeOf("منتظر هشت ۸") === "skipped_resume" && batchState(M8b) === "rejected" && (await scrapeMode()) === "manual");
reset(); addPost("telegram:test_channel_a", "پس از توقف ۹"); await prepareBatch(env);
T("M9 after leaving stop: new post is manual preview, not sent", stateOfPost("پس از توقف ۹") === "pending" && !groupHas("پس از توقف ۹"));
await hook(cbOwner(`sb:r:${batchOf("پس از توقف ۹")}`));

// M10) تغییر حالت، دسته‌ی sending و نتیجه‌ی مبهم را آزاد یا دوباره ارسال نمی‌کند
const now10 = Math.floor(clock.ms / 1000);
const S10 = raw.prepare("INSERT INTO scrape_batches (state, created_utc, expires_utc) VALUES ('sending', ?, ?) RETURNING id").get(now10, now10 + 43200).id;
addPost("telegram:test_channel_a", "مبهم ده ۱۰");
const P10 = q1("SELECT id FROM posts WHERE text = ?", "مبهم ده ۱۰").id;
raw.prepare("INSERT INTO scrape_batch_items (post_id, batch_id, unit) VALUES (?, ?, ?)").run(P10, S10, `scrape_batch:${S10}:x:0`);
raw.prepare("INSERT INTO effects (op_key, kind, state, row_id, update_id, lease, result, msg_id, last_error, at_utc) VALUES (?, 'tg_send', 'intent', NULL, NULL, '', '', NULL, '', ?)")
  .run(`scrape_batch:${S10}:x:0`, now10 - 3600);
await hook(cbOwner("ss:stop"));
tick(); reset(); await hook(cbOwner("ss:manual")); await hook(cbOwner("ss:go:manual:new"));
tick(); reset(); await hook(cbOwner("ss:auto")); await hook(cbOwner(tokBtn("ss:autoy:")));
const effAfter = q1("SELECT state FROM effects WHERE op_key = ?", `scrape_batch:${S10}:x:0`);
T("M10 mode changes keep sending batch and ambiguous effect untouched", batchState(S10) === "sending" && effAfter.state === "intent" && sentAt("مبهم ده ۱۰") === null && !groupHas("مبهم ده ۱۰"));

// M11) استقرار دوباره‌ی schema: تنظیم‌ها پاک نمی‌شوند
raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scrape_paused', '1')").run();
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
T("M11 re-applying schema keeps mode settings", setting("scrape_auto") === "1" && setting("scrape_paused") === "1" && (await scrapeMode()) === "stop");
raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scrape_paused', '0')").run();

// M12) ساعت سکوت و نتیجه‌ی مبهم در خودکار
// ساعت باید به جلو برود (زمان قبل از تغییر حالت نباشد): ۰۲:۰۰ تهران روز بعد
clock.ms = Date.UTC(2026, 9, 15, 22, 30); reset(); addPost("telegram:test_channel_a", "سکوت دوازده"); await prepareBatch(env);
T("M12 quiet hours: auto does not send", !groupHas("سکوت دوازده") && sentAt("سکوت دوازده") === null);
clock.ms = Date.UTC(2026, 9, 15, 8, 30); tick(); reset();
addPost("telegram:test_channel_a", "مبهم دوازده");
G.failAt = { n: (G.gc || 0) + 1, kind: "network" };
await prepareBatch(env);
const M12u = q1("SELECT state, reason FROM update_queue WHERE payload LIKE '%auto_batch%' ORDER BY update_id DESC LIMIT 1");
T("M12 auto ambiguous → needs_review, post not sent", M12u && M12u.state === "needs_review" && M12u.reason === "ambiguous" && sentAt("مبهم دوازده") === null);
const M12b = batchOf("مبهم دوازده");
T("M12 ambiguous batch stays sending (not expired/resent)", batchState(M12b) === "sending");
reset(); await hook(cbOwner("ss:manual"));
T("M12 mode change does not resend ambiguous post", !groupHas("مبهم دوازده") && batchState(M12b) === "sending");

// =====================================================================
// بازتولید ایرادهای بررسی 07414b3 (N1–N6 + توکن) و تست‌های سلامت بعد از اصلاح
// =====================================================================
const longOf = (ch, n) => ch.repeat(n);
const reviewRow = (id) => q1("SELECT state, reason FROM update_queue WHERE update_id = ?", id);
const effState = (key) => q1("SELECT state FROM effects WHERE op_key = ?", key)?.state ?? null;
const lastAnswer = () => answers[answers.length - 1] || "";

// R0) برای ادامه‌ی سناریوها: خودکار فعال با توکن
reset(); await hook(cbOwner("ss:auto")); tick(); const r0t = tokBtn("ss:autoy:"); reset(); await hook(cbOwner(r0t));
T("R0 setup: auto enabled through token", (await scrapeMode()) === "auto");

// R1) N1: خطای مبهم ارسال خودکار قابل تعیین تکلیف و قابل ادامه باشد
const rv1 = "ری ان ۱ " + "الف";
addPost("telegram:test_channel_a", rv1);
G.failAt = { n: (G.gc || 0) + 1, kind: "network" };
reset(); await prepareBatch(env);
// شناسه‌ی همین دسته (نه آخرین مورد دیگر، مثلاً مورد M12)
const rid = q1("SELECT update_id AS id FROM update_queue WHERE payload LIKE ? AND state = 'needs_review'", `%"batch":${batchOf(rv1)},%`)?.id;
T("R1 N1 auto ambiguous → needs_review with negative id", Number.isSafeInteger(rid) && rid < 0 && !groupHas(rv1));
reset(); await hook(cbOwner(`rv:n:${rid}`));
T("R1 N1 owner button «انجام نشد» accepts negative id (not «نامعتبر»)", lastAnswer() !== "نامعتبر" && q1("SELECT state, last_error FROM effects WHERE update_id = ?", rid)?.last_error === "owner_not_applied" && reviewRow(rid).state === "failed");
reset(); await hook(cbOwner(`rv:r:${rid}`));
T("R1 N1 retry after not_applied sends the text exactly once", groupHas(rv1) && G.sent.filter((m) => String(m.text).includes(rv1)).length === 1 && sentAt(rv1) !== null);
reset(); await hook(ownerDm("/retry_update 0"));
T("R1 N1 id 0 is still rejected with format message", ownerTexts().some((t) => t.startsWith("فرمت")));

// R2) N2: auto→manual وسط ارسال خودکار: باقی‌مانده نگه داشته شود؛ ادامه‌ی دستی مالک مجاز باشد
const rA = longOf("ق ", 1500), rB = longOf("ر ", 1500);
addPost("telegram:test_channel_a", rA); addPost("telegram:test_channel_a", rB);
G.afterOne = () => { raw.prepare("UPDATE settings SET value = '0' WHERE key = 'scrape_auto'").run(); };
reset(); await prepareBatch(env);
const rBid = batchOf(rA);
const r2units = new Set(qN("SELECT unit FROM scrape_batch_items WHERE batch_id = ? AND unit IS NOT NULL", rBid).map((x) => x.unit)).size;
T(`R2 setup: two independent units (units=${r2units})`, r2units >= 2);
T("R2 N2 mode switched to manual during auto run: first unit sent, second held", groupHas("ق ق ق") && !groupHas("ر ر ر") && batchState(rBid) === "sending" && (await scrapeMode()) === "manual");
reset(); await hook(cbOwner(`sb:c:${rBid}`));
T("R2 N2 owner manual continue still sends remaining unit once (not blocked)", groupHas("ر ر ر") && G.sent.filter((m) => String(m.text).includes("ر ر ر")).length === 1 && batchState(rBid) === "sent");

// R3) N3: فعال‌سازی اتمیک؛ خطای میانی نوشتن حالت را نیمه‌کاره نمی‌گذارد
clock.ms += 60000; // پست قدیمی قبل از فعال‌سازی
addPost("telegram:test_channel_a", "قدیمی سه ۳");
const realBatch = db.batch;
db.batch = async () => { db.batch = realBatch; throw new Error("simulated write failure"); };
const sinceBefore = setting("scrape_auto_since") ?? null;
let r3err = null;
try { await hook(cbOwner("ss:auto")); await hook(cbOwner(tokBtn("ss:autoy:"))); } catch (e) { r3err = e; }
db.batch = realBatch;
T("R3 N3 failed mode write leaves mode and cutoff unchanged", (await scrapeMode()) === "manual" && (setting("scrape_auto_since") ?? null) === sinceBefore && setting("scrape_auto") !== "1");
reset(); await prepareBatch(env);
T("R3 N3 no old backlog auto-published after failed enable", !groupHas("قدیمی سه ۳") && sentAt("قدیمی سه ۳") === null);

// R4) N4: /scrape_resume قدیمی روی دسته‌ی ambiguous همان ایمنی پنل را دارد
const nowR4 = Math.floor(clock.ms / 1000);
const S4 = raw.prepare("INSERT INTO scrape_batches (state, created_utc, expires_utc) VALUES ('sending', ?, ?) RETURNING id").get(nowR4, nowR4 + 43200).id;
addPost("telegram:test_channel_a", "مبهم چهار ۴");
const P4 = q1("SELECT id FROM posts WHERE text = ?", "مبهم چهار ۴").id;
raw.prepare("INSERT INTO scrape_batch_items (post_id, batch_id, unit) VALUES (?, ?, ?)").run(P4, S4, `scrape_batch:${S4}:y:0`);
raw.prepare("INSERT INTO effects (op_key, kind, state, row_id, update_id, lease, result, msg_id, last_error, at_utc) VALUES (?, 'tg_send', 'intent', NULL, NULL, '', '', NULL, '', ?)").run(`scrape_batch:${S4}:y:0`, nowR4 - 3600);
reset(); await hook(cbOwner("ss:stop"));
reset(); await hook(ownerDm("/scrape_resume"));
T("R4 N4 /scrape_resume keeps ambiguous unit intent and sending batch", effState(`scrape_batch:${S4}:y:0`) === "intent" && batchState(S4) === "sending" && sentAt("مبهم چهار ۴") === null && !groupHas("مبهم چهار ۴") && (await scrapeMode()) === "manual");

// R5) N5: /scrape_resume all بعد از auto→stop هیچ backlog را خودکار منتشر نمی‌کند
reset(); await hook(cbOwner("ss:stop"));
reset(); await hook(cbOwner("ss:auto")); tick(); await hook(cbOwner(tokBtn("ss:go:auto:new:")));
tick(); addPost("telegram:test_channel_a", "معوق پنج ۵"); reset(); await hook(cbOwner("ss:stop"));
reset(); await hook(ownerDm("/scrape_resume all"));
const r5b = batchOf("معوق پنج ۵");
T("R5 N5 resume-all after auto→stop previews backlog, does not publish", !groupHas("معوق پنج ۵") && sentAt("معوق پنج ۵") === null && batchState(r5b) === "pending" && (await scrapeMode()) === "manual");
reset(); await hook(cbOwner(`sb:r:${r5b}`));

// R6) N6: سکوت بین تلاش HTML و متن ساده؛ تلاش ساده ارسال نشود و واحد قابل ادامه بماند
reset(); await hook(cbOwner("ss:manual"));
const r6 = "پلکان شش ۶ " + "ب";
addPost("telegram:test_channel_a", r6);
G.htmlThenQuiet = "پلکان شش ۶";
clock.ms = Date.UTC(2026, 9, 15, 8, 30); reset(); await prepareBatch(env);
const r6b = batchOf(r6);
reset(); await hook(cbOwner(`sb:s:${r6b}`));
const r6eff = q1("SELECT state, last_error FROM effects WHERE op_key LIKE ? ORDER BY at_utc DESC LIMIT 1", `scrape_batch:${r6b}:%`);
T("R6 N6 quiet started after HTML refusal: plain fallback not sent", !groupHas("پلکان شش ۶") && sentAt(r6) === null && batchState(r6b) === "sending");
T("R6 N6 unit recorded as not_sent_quiet (retryable, not delivered)", r6eff && r6eff.state === "failed" && r6eff.last_error === "not_sent_quiet");
clock.ms = Date.UTC(2026, 9, 15, 8, 30); reset(); await hook(cbOwner(`sb:c:${r6b}`));
T("R6 N6 after quiet, owner continue sends exactly once", G.sent.filter((m) => String(m.text).includes("پلکان شش ۶")).length === 1 && sentAt(r6) !== null);

// R7) توکن تأیید خودکار: انصراف باطل می‌کند؛ توکن مصرف‌شده دوباره کار نمی‌کند
// حالت الان دستی است (R5/R6 به دستی رسیدند)
reset(); await hook(cbOwner("ss:auto")); const r7a = tokBtn("ss:autoy:");
reset(); await hook(cbOwner("ss:m"));
reset(); await hook(cbOwner(r7a));
T("R7 cancel invalidates auto token", (await scrapeMode()) === "manual" && lastAnswer().includes("منقضی"));
reset(); await hook(cbOwner("ss:auto")); const r7b = tokBtn("ss:autoy:");
reset(); await hook(cbOwner(r7b));
T("R7 valid token switches to auto", (await scrapeMode()) === "auto");
reset(); await hook(cbOwner(r7b));
T("R7 reused token is rejected (single use)", (await scrapeMode()) === "auto" && lastAnswer().includes("منقضی"));
clock.ms += 3600 * 1000; reset(); await hook(cbOwner("ss:manual")); reset(); await hook(cbOwner("ss:auto")); const r7c = tokBtn("ss:autoy:"); clock.ms += 400 * 1000;
reset(); await hook(cbOwner(r7c));
T("R7 expired token (>5 min) is rejected", (await scrapeMode()) === "manual" && lastAnswer().includes("منقضی"));

// R9) تلاش مجدد خودکار پس از تغییر حالت: پیام واقعی نتیجه، و باقی‌مانده فقط با ادامه‌ی دستی
reset(); await hook(cbOwner("ss:auto")); tick(); await hook(cbOwner(tokBtn("ss:autoy:")));
const rv9 = "ری ان نه ۹";
addPost("telegram:test_channel_a", rv9);
G.failAt = { n: (G.gc || 0) + 1, kind: "network" };
reset(); await prepareBatch(env);
const b9 = batchOf(rv9);
const rid9 = q1("SELECT update_id AS id FROM update_queue WHERE payload LIKE ? AND state = 'needs_review'", `%"batch":${b9},%`)?.id;
reset(); await hook(cbOwner(`rv:n:${rid9}`));
reset(); await hook(cbOwner("ss:manual"));
reset(); await hook(cbOwner(`rv:r:${rid9}`));
T("R9 auto retry after mode change explains the stop (no false «انجام شد»)", lastAnswer().includes("حالت ارسال خودکار تغییر کرد") && !groupHas(rv9) && batchState(b9) === "sending");
reset(); await hook(cbOwner(`sb:c:${b9}`));
T("R9 owner manual continue sends it exactly once", G.sent.filter((m) => String(m.text).includes(rv9)).length === 1 && batchState(b9) === "sent");

// R8) /scrape_resume بیرون از توقف هیچ‌چیز را تغییر نمی‌دهد (دسته‌ی منتظر و حالت سر جایش)
reset(); await hook(cbOwner("ss:manual"));
addPost("telegram:test_channel_a", "منتظر هشت ب"); reset(); await prepareBatch(env); const r8b = batchOf("منتظر هشت ب");
reset(); await hook(ownerDm("/scrape_resume"));
T("R8 resume outside stop is a no-op (pending batch kept, mode kept)", batchState(r8b) === "pending" && (await scrapeMode()) === "manual" && ownerTexts().some((t) => t.includes("متوقف نیست")));
reset(); await hook(cbOwner(`sb:r:${r8b}`));

console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
