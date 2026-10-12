// دستورهای عمومی گروه: /week /next /term /left
// پاسخ‌ها روزانه کش می‌شن؛ سؤال تکراری با ریپلای به پاسخ اصلی جواب داده می‌شه.
import { tg } from "./telegram.js";
import {
  tehranToday, weekIndex, parityOf, rangeText, endOfClasses, daysBetween, faDate, faNum, addDays, WEEKS,
} from "./calendar.js";

const nowUtc = () => Math.floor(Date.now() / 1000);

export async function getSetting(env, key, fallback = null) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : fallback;
}

function buildAnswer(cmd, startIso, today) {
  const idx = weekIndex(startIso, today);
  const before = daysBetween(today, startIso) > 0;

  if (cmd === "/left") {
    const end = endOfClasses(startIso);
    if (before) return `ترم هنوز شروع نشده. شروع کلاس‌ها: ${faDate(startIso)}.`;
    const left = daysBetween(today, end);
    if (left < 0) return "کلاس‌های این ترم تمام شده.";
    return `تا پایان کلاس‌ها ${faNum(left)} روز مونده (تا ${faDate(end)}).`;
  }

  if (cmd === "/term") {
    const lines = [];
    for (let i = 1; i <= WEEKS; i++) {
      const mark = i === idx ? "  ◀ الان" : "";
      lines.push(`هفته ${faNum(i)} (${parityOf(i)}): ${rangeText(startIso, i)}${mark}`);
    }
    return ["فهرست هفته‌های ترم:", ...lines].join("\n");
  }

  if (cmd === "/next") {
    if (before) return `ترم هنوز شروع نشده. شروع کلاس‌ها: ${faDate(startIso)}.`;
    const nextIdx = idx === null ? null : idx + 1;
    if (nextIdx === null || nextIdx > WEEKS) return "هفته‌ی بعد کلاسی نیست.";
    return `هفته ${faNum(nextIdx)} — ${parityOf(nextIdx)}\n${rangeText(startIso, nextIdx)}`;
  }

  // /week
  if (before) return `ترم هنوز شروع نشده. شروع کلاس‌ها: ${faDate(startIso)}.`;
  if (idx === null) return "کلاس‌های این ترم تمام شده.";
  return `هفته ${faNum(idx)} — ${parityOf(idx)}\n${rangeText(startIso, idx)}`;
}

async function sendFresh(env, chatId, text) {
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  return sent.message_id;
}

export async function answerPublic(env, chatId, cmd) {
  const startIso = await getSetting(env, "semester_start", "2026-09-12");
  const today = tehranToday();
  const key = `${cmd}|${today}`;
  const text = buildAnswer(cmd, startIso, today);

  const cached = await env.DB.prepare("SELECT message_id FROM week_cache WHERE key = ? AND chat_id = ?")
    .bind(key, chatId).first();

  if (cached) {
    try {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "جواب این سؤال بالاتره ↑",
        reply_to_message_id: cached.message_id,
        allow_sending_without_reply: false,
      });
      return;
    } catch {
      // پیام اصلی پاک شده یا در دسترس نیست: جواب تازه می‌دیم
    }
  }

  const messageId = await sendFresh(env, chatId, text);
  await env.DB.prepare(
    `INSERT INTO week_cache (key, chat_id, message_id, created_utc) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, chat_id) DO UPDATE SET message_id = excluded.message_id, created_utc = excluded.created_utc`
  ).bind(key, chatId, messageId, nowUtc()).run();
}
