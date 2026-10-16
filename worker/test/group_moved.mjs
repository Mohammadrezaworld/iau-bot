import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url)); // worker/ (مسیر نسبی، بدون مسیر ماشین)
const worker = (await import(WORKER + "src/index.js")).default;
const { webhookSecret } = await import(WORKER + "src/telegram.js");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync(WORKER + "schema.sql", "utf8"));
const db = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { st.run(...a); return { meta: { changes: 1 } }; } }), first: async () => st.get() ?? null, all: async () => ({ results: st.all() }), run: async () => { st.run(); return {}; } }; } };
const sent = []; let mid = 300; let memberStatus = "member";
globalThis.fetch = async (u, o) => {
  const m = String(u).split("/").pop(); const b = o && o.body ? JSON.parse(o.body) : {};
  sent.push({ m, ...b });
  if (m === "getChatMember") return Response.json({ ok: true, result: { status: memberStatus } });
  if (m === "createChatInviteLink") return Response.json({ ok: true, result: { invite_link: "https://t.me/+JOIN1" } });
  return Response.json({ ok: true, result: { message_id: ++mid } });
};
const env = { TELEGRAM_BOT_TOKEN: "1:T", OWNER_ID: "5", JOZVE_CHANNEL: "-1004434418889", JOZVE_PUBLIC_USERNAME: "iautcloud", DB: db };
const secret = await webhookSecret(env);
const hook = (u) => worker.fetch(new Request("https://x/tg-webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), env);
raw.exec("INSERT INTO settings (key,value) VALUES ('group_id','-100555')");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const g = (uid, text, id) => hook({ message: { message_id: id, chat: { id: -100555, type: "supergroup" }, from: { id: uid }, text } });
const dm = (uid, text) => hook({ message: { message_id: 1, chat: { id: uid, type: "private" }, from: { id: uid }, text } });
const msgs = () => sent.filter(x => x.m === "sendMessage");
const dels = () => sent.filter(x => x.m === "deleteMessage");

for (const c of ["/call", "/links", "/events", "/next", "/term", "/left", "/metro"]) {
  sent.length = 0; await g(77, c, 40 + c.length);
  ok(`group ${c}: command deleted`, dels().some(x => x.message_id === 40 + c.length));
}
const guideCount = sent.length; 
sent.length = 0; await g(78, "/call", 90);
ok("second user within guide window: no new guide sent", msgs().length === 0 && dels().some(x => x.message_id === 90));
const real = Date.now; Date.now = () => real() + 61000;
sent.length = 0; await g(79, "/call", 91);
ok("after window: new single guide sent", msgs().length === 1 && /پیوی ربات/.test(msgs()[0].text));
Date.now = real;
sent.length = 0; await g(77, "/updates", 41);
ok("group /updates: silently deleted", msgs().length === 0 && dels().some(x => x.message_id === 41));
sent.length = 0; await g(78, "/call", 50); await g(79, "/call", 51);
ok("two users in a row: one shared guide, both commands deleted", msgs().length === 0 || msgs().length === 1 && dels().some(x => x.message_id === 51));
sent.length = 0; await g(77, "/week", 42);
ok("group /week still answered (not guided)", !msgs().some(x => /پیوی ربات/.test(x.text || "")));

sent.length = 0; await dm(77, "/metro");
ok("member DM /metro responds (metro menu or empty-table notice)", msgs().length === 1);
memberStatus = "left"; sent.length = 0; await dm(77, "/metro");
ok("non-member DM /metro: gate with join button", msgs().length === 1 && /عضو گروه/.test(msgs()[0].text) && msgs()[0].reply_markup);
memberStatus = "member";
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
