// فاز ۲ ایرادهای قدیمی: A2 (retry پیام متنی ویزارد)، A5 (دکمه‌ی قدیمی ویزارد)، B2 (شمارنده‌ی کلیک DM هم‌زمان)
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { startWizard, handleWizardText, handleCallback } = await import(WORKER + "src/wizard.js");
const { takeDmClick } = await import(WORKER + "src/jozve.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
// پایگاه داده‌ی تست با changes واقعی و batch؛ هر await یک نقطه‌ی هم‌روندی است
const mk = (sql, args = []) => ({
  bind: (...a) => mk(sql, a),
  first: async () => { await Promise.resolve(); return raw.prepare(sql).get(...args) ?? null; },
  all: async () => ({ results: raw.prepare(sql).all(...args) }),
  run: async () => { await Promise.resolve(); const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const db = { prepare: (sql) => mk(sql), batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 1 } });
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const sess = (uid) => raw.prepare("SELECT * FROM admin_sessions WHERE user_id = ?").get(uid);
const cb = (uid, data, id = "c" + Math.random()) => ({ id, data, from: { id: uid }, message: { chat: { id: -100 } } });
const msg = (uid, text, mid) => ({ message_id: mid, from: { id: uid }, chat: { id: uid }, text });
const contacts = () => raw.prepare("SELECT COUNT(*) AS n FROM contacts").get().n;

// ── A2: retry همان پیام متنی، مرحله را دوباره پیش نمی‌برد
await startWizard(env, 11, 11, "call");
await handleWizardText(env, msg(11, "آموزش", 7001));
ok("A2: first text advances to step 1", sess(11).step === 1);
await handleWizardText(env, msg(11, "آموزش", 7001));
ok("A2: retry of the same message does not advance again", sess(11).step === 1);
await handleWizardText(env, msg(11, "آموزش کامپیوتر", 7002));
ok("A2: next distinct message advances normally", sess(11).step === 2);

// ── A5: دکمه‌ی «ثبت» وقتی هنوز در مرحله‌ی خلاصه نیستیم اثری ندارد
await startWizard(env, 12, 12, "call");
let threw = false;
try { await handleCallback(env, cb(12, "w:ok")); } catch { threw = true; }
ok("A5: stale confirm button does not throw", !threw);
ok("A5: stale confirm button inserts nothing", contacts() === 0 && sess(12).step === 0);

await startWizard(env, 13, 13, "event");
await handleCallback(env, cb(13, "w:kind:exam"));
ok("A5: kind button outside its step is ignored", sess(13).step === 0);

// ── مسیر کامل سالم: همچنان ثبت می‌شود
await startWizard(env, 14, 14, "call");
await handleWizardText(env, msg(14, "آموزش", 8001));
await handleWizardText(env, msg(14, "آموزش کامپیوتر", 8002));
await handleWizardText(env, msg(14, "۰۴۱۳۱۹۶۶۱۳۱", 8003));
await handleWizardText(env, msg(14, "بدون یادداشت", 8004));
ok("normal flow reaches confirmation step", sess(14).step === 4);
await handleCallback(env, cb(14, "w:ok"));
ok("normal flow confirm inserts exactly one contact", contacts() === 1);
await handleCallback(env, cb(14, "w:ok"));
ok("double confirm does not insert twice", contacts() === 1);

// ── B2: پنج کلیک هم‌زمان با سهمیه‌ی ۳ تایی: فقط ۳ تا مجاز
const results = await Promise.all([1, 2, 3, 4, 5].map(() => takeDmClick(env, 77)));
const allowed = results.filter(Boolean).length;
ok("B2: concurrent clicks cannot exceed the burst (3)", allowed === 3);

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
