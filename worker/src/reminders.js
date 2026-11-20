// یادآوری رویدادها: کرون دقیقه‌ای بررسی می‌کنه؛ هیچ پیامی مستقیم به گروه نمی‌ره.
// هر یادآوری اول در پیوی مالک با دکمه‌ی «ارسال به گروه» / «نفرست» می‌آد (rm2:s|r:<id>:<kind>).
// زمان‌ها (تهران): روز قبل و هفت روز قبل ۲۰:۰۰، روز رویداد ۰۶:۳۰. میان‌ترم: ۷ روز قبل + ۱ روز قبل + روز رویداد.
// رویدادی که دیر ثبت شود (بعد از ۰۸:۰۰ روز قبل): فقط یک یادآوری فوری، و یادآوری‌های دیگر حذف می‌شن.
import { tg } from "./telegram.js";
import { tehranToday, addDays, faDate, faNum, daysBetween } from "./calendar.js";
import { getSetting } from "./public.js";
import { inTehranQuietHours } from "./channels.js";
import { isOwner } from "./admin.js";
import { claimExternal, finishExternal, LeaseLostError, AmbiguousError } from "./effects.js";

const EVENING = [20, 0];
const MORNING = [6, 30];
const EARLY = [8, 0];
const LABEL = { pre7: "۷ روز قبل", pre1: "یک روز قبل", day: "روز رویداد", now: "فوری (تازه ثبت شده)" };

const norm = (s) => String(s || "").replace(/[‌\s]/g, "");
// تهران UTC+3:30 و بدون ساعت تابستانی: ساعت محلی را به میلی‌ثانیه‌ی UTC تبدیل می‌کنیم
const tehranMs = (iso, [h, m]) => { const [y, mo, d] = iso.split("-").map(Number); return Date.UTC(y, mo - 1, d, h - 3, m - 30); };

export function plannedKinds(kind) {
  const midterm = norm(kind) === "میانترم";
  const list = midterm ? [["pre7", -7, EVENING], ["pre1", -1, EVENING]] : [["pre1", -1, EVENING]];
  return [...list, ["day", 0, MORNING]];
}

async function mark(env, eventId, kind) {
  await env.DB.prepare("INSERT OR IGNORE INTO reminder_log (event_id, kind) VALUES (?, ?)").bind(eventId, kind).run();
}

export function groupText(e, today) {
  const diff = daysBetween(today, e.start_date);
  const when = diff <= 0 ? "امروز" : diff === 1 ? "فردا" : `${faNum(diff)} روز دیگه`;
  return `📢 یادآوری: ${when} (${faDate(e.start_date)}) — ${e.title}\n#یادآوری`;
}

export async function processReminders(env, now = Date.now()) {
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return;
  // ساعت سکوت: چیزی پرسیده یا ثبت نمی‌شه، تا اجرای بعدی بیرون از سکوت
  if (await inTehranQuietHours(env)) return;

  const today = tehranToday(now);
  const { results: events } = await env.DB.prepare(
    "SELECT * FROM events WHERE archived = 0 AND start_date >= ? ORDER BY start_date, id"
  ).bind(today).all();

  for (const e of events) {
    const { results: rows } = await env.DB.prepare("SELECT kind FROM reminder_log WHERE event_id = ?").bind(e.id).all();
    const done = new Set(rows.map((r) => r.kind));
    // کلید قدیمی «pre» همان «روز قبل» است؛ «day» هم یکی است
    const handled = (k) => done.has(k) || done.has(`skip:${k}`) || (k === "pre1" && done.has("pre"));
    // بار اول که رویداد دیده می‌شه = زمان ثبت (رویدادهای قدیمی‌تر از این تغییر، «pre» یا «day» دارن)
    const firstSight = !done.has("seen") && !done.has("pre") && !done.has("day");

    let plan = plannedKinds(e.kind).map(([k, off, t]) => ({ kind: k, due: tehranMs(addDays(e.start_date, off), t) }));
    if (firstSight) {
      // دیر ثبت شده (بعد از ۰۸:۰۰ روز قبل): فقط یک یادآوری فوری؛ بقیه حذف
      const early = now >= tehranMs(addDays(e.start_date, -1), EARLY);
      for (const p of plan) if (early || p.due < now) { await mark(env, e.id, `skip:${p.kind}`); done.add(`skip:${p.kind}`); }
      if (early) plan = [{ kind: "now", due: now }];
    }
    for (const p of plan) {
      if (handled(p.kind) || p.due > now) continue;
      await tg(env, "sendMessage", {
        chat_id: env.OWNER_ID,
        text: `یادآوری برای گروه (${LABEL[p.kind]}):\n\n${groupText(e, today)}`,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[
          { text: "ارسال به گروه", callback_data: `rm2:s:${e.id}:${p.kind}` },
          { text: "نفرست", callback_data: `rm2:r:${e.id}:${p.kind}` },
        ]] },
      });
      await mark(env, e.id, p.kind);
    }
    if (firstSight) await mark(env, e.id, "seen");
  }
}

export async function handleReminderCallback(env, cq, ctx = null) {
  const answer = (text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  await answer();
  const chat = cq.message?.chat;
  if (!chat || chat.type !== "private") return;
  const chatId = chat.id;
  if (!(await isOwner(env, cq.from.id))) return;
  const [, op, id, kind] = String(cq.data || "").split(":");
  const eventId = Number(id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0 || !["s", "r"].includes(op) || !Object.hasOwn(LABEL, kind)) {
    return tg(env, "sendMessage", { chat_id: chatId, text: "این دکمه معتبر نیست؛ دوباره /review را بررسی کن." });
  }
  const done = await env.DB.prepare("SELECT 1 AS x FROM reminder_log WHERE event_id = ? AND kind = ?").bind(eventId, `done:${kind}`).first();
  if (done) return tg(env, "sendMessage", { chat_id: chatId, text: "این یادآوری قبلاً جواب گرفته." });
  const e = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();
  if (!e || e.archived) return tg(env, "sendMessage", { chat_id: chatId, text: "این رویداد دیگه فعال نیست." });
  const groupId = op === "s" ? await getSetting(env, "group_id", "") : "";
  if (op === "s" && !groupId) return tg(env, "sendMessage", { chat_id: chatId, text: "گروه اصلی تنظیم نیست؛ یادآوری ارسال نشد." });

  // approve و reject برای یک یادآوری از یک کلید استفاده می‌کنند تا کلیک‌های هم‌زمان یک تصمیم را برنده کنند.
  const opKey = `reminder:${eventId}:${kind}`;
  const claim = await claimExternal(env, ctx, opKey, "reminder");
  if (claim.status === "lease_lost") throw new LeaseLostError();
  if (claim.status === "busy") return tg(env, "sendMessage", { chat_id: chatId, text: "این یادآوری در حال پردازشه؛ چند لحظه بعد دوباره بررسی کن." });
  if (claim.status === "ambiguous") throw new AmbiguousError(opKey);
  if (claim.status === "done") {
    // اگر ثبت reminder_log بعد از اثر موفق شکست خورده باشد، فقط marker را ترمیم می‌کنیم؛ ارسال تکرار نمی‌شود.
    await mark(env, eventId, `done:${kind}`);
    return tg(env, "sendMessage", { chat_id: chatId, text: "این یادآوری قبلاً جواب گرفته." });
  }

  if (op === "r") {
    let finished = false;
    try { finished = await finishExternal(env, ctx, opKey, { ok: true, result: "rejected" }); } catch {}
    if (!finished) throw new AmbiguousError(opKey);
    await mark(env, eventId, `done:${kind}`);
    return tg(env, "sendMessage", { chat_id: chatId, text: "یادآوری ارسال نشد." });
  }

  let sent;
  try {
    sent = await tg(env, "sendMessage", { chat_id: groupId, text: groupText(e, tehranToday()), disable_web_page_preview: true });
  } catch (err) {
    if (err && err.refused) {
      let recorded = false;
      try { recorded = await finishExternal(env, ctx, opKey, { ok: false, error: err.message }); } catch {}
      if (!recorded) throw new AmbiguousError(opKey);
      throw err;
    }
    throw new AmbiguousError(opKey);
  }
  let finished = false;
  try { finished = await finishExternal(env, ctx, opKey, { ok: true, msgId: sent?.message_id, result: "approved" }); } catch {}
  if (!finished) throw new AmbiguousError(opKey);
  await mark(env, eventId, `done:${kind}`);
  return tg(env, "sendMessage", { chat_id: chatId, text: "یادآوری به گروه ارسال شد." });
}
