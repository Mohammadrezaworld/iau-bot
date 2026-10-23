// دکمه‌ی «لغو» ویزارد: روی جلسه‌ی تمام‌شده یا دکمه‌ی قدیمی، «لغو شد» نمی‌گوید؛ «دیگه فعال نیست» می‌گوید
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { startWizard, handleCallback } = await import(WORKER + "src/wizard.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const mk = (sql, args = []) => ({
  bind: (...a) => mk(sql, a),
  first: async () => raw.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: raw.prepare(sql).all(...args) }),
  run: async () => { await Promise.resolve(); const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const db = { prepare: (sql) => mk(sql), batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
const sent = [];
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const sess = (uid) => raw.prepare("SELECT * FROM admin_sessions WHERE user_id = ?").get(uid);
const cb = (uid, data) => ({ id: "c" + Math.random(), data, from: { id: uid }, message: { chat: { id: -100 } } });
const said = (text) => sent.some((x) => x.m === "sendMessage" && x.text === text);
const answered = (text) => sent.some((x) => x.m === "answerCallbackQuery" && x.text === text);

// ۱. جلسه‌ی فعال: «لغو» جلسه را پاک می‌کند و «لغو شد» می‌گوید
await startWizard(env, 31, 31, "call");
ok("setup: wizard session exists", !!sess(31));
sent.length = 0;
await handleCallback(env, cb(31, "w:stop"));
ok("active wizard: session cleared", !sess(31));
ok("active wizard: says «لغو شد»", said("لغو شد."));

// ۲. جلسه‌ی تمام‌شده / دکمه‌ی قدیمی: «دیگه فعال نیست»، و «لغو شد» نمی‌گوید
sent.length = 0;
await handleCallback(env, cb(31, "w:stop"));
ok("stale wizard «لغو»: says «این جریان دیگه فعال نیست»", answered("این جریان دیگه فعال نیست"));
ok("stale wizard «لغو»: does not say «لغو شد»", !said("لغو شد."));

// ۳. «نه» در تأیید حذف (w:cancel بدون جلسه) همان «لغو شد» قبلی را دارد
sent.length = 0;
await handleCallback(env, cb(31, "w:cancel"));
ok("delete «نه» (w:cancel without session): still says «لغو شد»", said("لغو شد."));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
