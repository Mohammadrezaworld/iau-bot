// «فردا هفته فرد؟»: هفته‌ای که فردا در آن است؛ جمعه‌شب هفته‌ی بعد، وسط هفته همان هفته‌ی جاری
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const { isParityQuestion, asksTomorrow } = await import(WORKER + "src/public.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 1500;
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  const id = ++mid; sent.push({ m, ...b, _id: id });
  return Response.json({ ok: true, result: m === "setMessageReaction" ? true : { message_id: id } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
// ساعت تهران = UTC+3:30
const at = (y, mo, d, h, mi) => { Date.now = () => Date.UTC(y, mo - 1, d, h - 3, mi - 30); };
let uid = 300; let msgId = 7000;
const ask = async (text) => { sent.length = 0; uid++; await hook({ message: { message_id: ++msgId, chat: { id: -100555, type: "supergroup" }, from: { id: uid }, text } }); return sent.find((x) => x.m === "sendMessage" && String(x.chat_id) === "-100555"); };

ok("recognised: «فردا هفته فرد؟» is a parity question", isParityQuestion("فردا هفته فرد؟"));
ok("recognised: «فردا» is detected as tomorrow", asksTomorrow("فردا هفته فرد؟") && !asksTomorrow("این هفته فرد؟"));
ok("«فردا» inside another word is not tomorrow", !asksTomorrow("فردای ما هفته فرد؟"));

// جمعه ۲۳:۵۰ (هفته‌ی ۶ = زوج؛ فردا شنبه = هفته‌ی ۷ = فرد)
at(2026, 10, 23, 23, 50);
const fri = await ask("فردا هفته فرد؟");
ok("Fri 23:50 «فردا هفته فرد؟» answers the week that starts tomorrow (week ۷ فرد)", fri && fri.text.includes("هفته ۷") && fri.text.includes("فرد") && fri.reply_to_message_id);
const friNow = await ask("این هفته فرد؟");
ok("Fri 23:50 «این هفته فرد؟» still answers the current week (week ۶ زوج)", friNow && friNow.text.includes("هفته ۶") && friNow.text.includes("زوج"));

// چهارشنبه ۱۰:۰۰ (هفته‌ی ۶ = زوج؛ فردا پنجشنبه همان هفته)
at(2026, 10, 21, 10, 0);
const wed = await ask("فردا هفته زوج؟");
ok("Wed 10:00 «فردا هفته زوج؟» answers the same week (week ۶ زوج)", wed && wed.text.includes("هفته ۶") && wed.text.includes("زوج"));

console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
