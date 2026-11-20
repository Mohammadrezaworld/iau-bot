// فاز ۱ ایرادهای قدیمی: D2 یادآوری در ساعت سکوت، B1 تأیید آپلود مترو با سطح دسترسی فعلی
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { processReminders } = await import(WORKER + "src/reminders.js");
const { handleMetroUploadCallback, handleMetroCallback } = await import(WORKER + "src/metro.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const events = [];
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => { events.push(`db:${sql}`); return st.get(...a) ?? null; }, all: async () => ({ results: st.all(...a) }), run: async () => { events.push(`db:${sql}`); st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { events.push(`db:${sql}`); st.run(); return {}; } }; } };
const sent = [];
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  events.push(`tg:${m}`);
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
const at = (hourTehran) => { Date.now = () => Date.UTC(2026, 9, 17, hourTehran - 3, 30, 0); };
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555'),('quiet','2-6')");
raw.exec("INSERT INTO events (start_date,end_date,title,kind,archived) VALUES ('2026-10-17','2026-10-17','امتحان','',0)");
const reminderLogged = () => raw.prepare("SELECT COUNT(*) AS n FROM reminder_log").get().n;

// ۱. D2: ساعت ۰۳ (سکوت) → نه پرسش از مالک، نه ثبت
at(3); sent.length = 0;
await processReminders(env);
ok("D2: no reminder asked during quiet hours", sent.filter((x) => x.m === "sendMessage").length === 0);
ok("D2: nothing logged during quiet hours (so next run can ask)", reminderLogged() === 0);

// ۲. D2: ساعت ۱۲ (بیرون از سکوت) → پرسش از مالک (نه مستقیم به گروه) و ثبت
at(12); sent.length = 0;
await processReminders(env);
ok("D2: reminder asked to the owner outside quiet hours", sent.some((x) => x.m === "sendMessage" && String(x.chat_id) === "5" && /امتحان/.test(x.text || "")));
ok("D2: nothing sent directly to the group", !sent.some((x) => String(x.chat_id) === "-100555"));
ok("D2: asked reminder logged (no repeat ask)", raw.prepare("SELECT 1 FROM reminder_log WHERE kind = 'now'").get() !== undefined);

// ۳. B1: تأیید آپلود مترو
const pending = (actor) => {
  raw.exec(`INSERT INTO pending_actions (actor_id, action, payload, expires_utc) VALUES (${actor}, 'metro_upload', '${JSON.stringify({ kind: "regular", stations: [] })}', ${Math.floor(Date.now() / 1000) + 900})`);
  return raw.prepare("SELECT MAX(id) AS id FROM pending_actions").get().id;
};
const cq = (id, uid) => ({ id: "cq" + id, data: `mu:ok:${id}`, from: { id: uid }, message: { chat: { id: -100555 } } });
const versions = () => raw.prepare("SELECT COUNT(*) AS n FROM metro_versions").get().n;
at(12);

raw.exec("DELETE FROM admin_roles");
let pid = pending(77);
await handleMetroUploadCallback(env, cq(pid, 77));
ok("B1: admin without role (removed) cannot confirm", versions() === 0 && raw.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE id = ?").get(pid).n === 0);

raw.exec("INSERT INTO admin_roles (user_id, role) VALUES (78, 'content')");
pid = pending(78);
await handleMetroUploadCallback(env, cq(pid, 78));
ok("B1: content-level admin cannot confirm", versions() === 0);

raw.exec("INSERT INTO admin_roles (user_id, role) VALUES (79, 'full')");
pid = pending(79);
events.length = 0; sent.length = 0;
await handleMetroUploadCallback(env, cq(pid, 79));
const uploadAckAt = events.indexOf("tg:answerCallbackQuery");
const uploadWriteAt = events.findIndex((e) => e.startsWith("db:INSERT INTO metro_versions"));
ok("B1: full-level admin confirmation acknowledges before activating table", versions() === 1 && uploadAckAt >= 0 && uploadWriteAt > uploadAckAt && sent.some((m) => m.m === "sendMessage"));

// ۴. مسیر مبدأ/مقصد: ack پیش از ویرایش پیام تلگرام
const vId = raw.prepare("INSERT INTO metro_versions (created_utc, is_active, data_json) VALUES (1, 1, ?)").run(JSON.stringify({ kind: "regular", stations: ["A", "B"] })).lastInsertRowid;
events.length = 0; sent.length = 0;
await handleMetroCallback(env, { id: "metro-edit-ack-test", from: { id: 79 }, data: `m:s:79:${vId}`, message: { message_id: 888, chat: { id: -100555, type: "supergroup" } } });
ok("B2: metro callback acknowledges before editing its menu", events.indexOf("tg:answerCallbackQuery") >= 0 && events.indexOf("tg:answerCallbackQuery") < events.indexOf("tg:editMessageText") && sent.some((m) => m.m === "editMessageText"));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
