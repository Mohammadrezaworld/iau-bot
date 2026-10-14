import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 1;
globalThis.fetch = async (u, o) => { const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {}; sent.push({ m, ...b }); return Response.json({ ok: true, result: { message_id: ++mid } }); };
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-1004434418889", DB: db };
const secret = await (await import(WORKER + "src/telegram.js")).webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
for (const uid of [77, 5]) {
  sent.length = 0;
  await hook({ message: { message_id: 50 + uid, chat: { id: -100555, type: "supergroup" }, from: { id: uid }, text: "/jozve" } });
  const out = sent.find(x => x.m === "sendMessage");
  ok(`user ${uid}: command deleted`, sent.some(x => x.m === "deleteMessage" && x.message_id === 50 + uid));
  ok(`user ${uid}: guidance shown once (shared), no keyboard`, uid === 77 ? (out && /پیوی/.test(out.text) && !out.reply_markup) : (!out));
  ok(`user ${uid}: no copyMessage`, !sent.some(x => x.m === "copyMessage"));
}
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
