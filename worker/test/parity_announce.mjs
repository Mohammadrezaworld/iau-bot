// اعلام جمعه‌شب: هفته‌ی آینده زوج/فرد در گروه، ساعت ۲۳:۳۰ تهران، یک بار برای هر هفته
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { announceParity, ANNOUNCE_KEY } = await import(WORKER + "src/parity_announce.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = [];
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
// ساعت تهران = UTC+3:30. جمعه ۲۳ اکتبر ۲۰۲۶
const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 3, mi - 30);

ok("Fri 23:29 Tehran: no announcement", !(await announceParity(env, at(2026, 10, 23, 23, 29))) && sent.length === 0);
ok("Sat 23:30 Tehran: no announcement (only Friday)", !(await announceParity(env, at(2026, 10, 24, 23, 30))) && sent.length === 0);

// هفته‌ی ۷ (فرد): شنبه ۲۴ اکتبر تا جمعه ۳۰ اکتبر
const first = await announceParity(env, at(2026, 10, 23, 23, 30));
ok("Fri 23:30 Tehran: announced once", first === true && sent.filter((x) => x.m === "sendMessage").length === 1);
ok("announcement goes to the group", sent[0] && String(sent[0].chat_id) === "-100555");
ok("announcement says next week is فرد (week 7)", sent[0] && sent[0].text.includes("فرد") && !sent[0].text.includes("زوج"));
ok("announcement contains the next week's date range", sent[0] && /شنبه/.test(sent[0].text) && /جمعه/.test(sent[0].text));
ok("sent week is stored", raw.prepare("SELECT value FROM settings WHERE key = ?").get(ANNOUNCE_KEY)?.value === "7");

// همان شب، دقیقه‌های بعد: تکرار نشه
sent.length = 0;
ok("Fri 23:31 and 23:59 same week: no repeat", !(await announceParity(env, at(2026, 10, 23, 23, 31))) && !(await announceParity(env, at(2026, 10, 23, 23, 59))) && sent.length === 0);

// جمعه‌ی بعد: هفته‌ی ۸ (زوج)
const second = await announceParity(env, at(2026, 10, 30, 23, 30));
ok("next Friday: announced for week 8 (زوج)", second === true && sent.length === 1 && sent[0].text.includes("زوج") && !sent[0].text.includes("فرد"));

// بدون گروه: چیزی فرستاده نمی‌شه و علامت ثبت نمی‌شه
raw.exec("DELETE FROM settings WHERE key = 'group_id'");
sent.length = 0;
ok("no group configured: nothing sent", !(await announceParity(env, at(2026, 11, 6, 23, 30))) && sent.length === 0);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
