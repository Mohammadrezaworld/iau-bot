// دستورهای عمومی گروه: /week /next /term /left
// پاسخ‌ها کش می‌شن (روز + متن)؛ سؤال تکراری با ریپلای به پاسخ اصلی جواب داده می‌شه.
import { tg } from "./telegram.js";
import {
  tehranToday, weekIndex, parityOf, rangeText, endOfClasses, daysBetween, faDate, faNum, addDays, WEEKS,
} from "./calendar.js";

const nowUtc = () => Math.floor(Date.now() / 1000);

// پرسش آزاد زوج/فرد: فقط اگه همه‌ی کلمه‌ها از مجموعه‌ی مجاز باشن و هر دو «زوج» و «فرد» باشن.
// مثال‌ها: «زوج یا فرد؟»، «این هفته فرد هست یا زوج؟»، «این هفته زوج هست یا فرد»
// شکل‌های محاوره‌ای («زوجه»، «فرده») به زوج و فرد برمی‌گردن. پرسش باید «؟» یا «یا» داشته باشه؛ جمله‌ی خبری («این هفته فرد هست») جواب نمی‌گیره.
const PARITY_WORDS = new Set(["این", "هفته", "زوج", "فرد", "زوجه", "فرده", "یا", "هست"]);
export function isParityQuestion(text) {
  const raw = String(text || "");
  if (!/[؟?]/.test(raw) && !/(^|\s)یا(\s|$)/.test(raw.replace(/\u200c/g, " "))) return false;
  const words = raw.replace(/\u200c/g, " ").replace(/[؟?!.،,]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (!words.every((w) => PARITY_WORDS.has(w))) return false;
  const norm = words.map((w) => (w === "زوجه" ? "زوج" : w === "فرده" ? "فرد" : w));
  return norm.includes("زوج") || norm.includes("فرد"); // «این هفته فرده؟» هم پرسشه
}

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

async function sendFresh(env, chatId, text, replyTo = null) {
  const extra = replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {};
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
  return sent.message_id;
}

// کش پاسخ: کلید = نام دستور + روز + هش متن. اگه متن عوض شده باشه (مثلاً تغییر شروع ترم یا شماره‌ها)، جواب تازه می‌ره.
// اگه سؤال تکراری باشه، ربات زیر پاسخ قبلی ریپلای می‌زنه؛ اگه پیام قبلی پاک شده باشه، جواب تازه می‌ده.
export async function sendCachedAnswer(env, chatId, baseKey, text, send) {
  const key = `${baseKey}|${await shortHash(text)}`;
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

  const messageId = await send();
  if (!messageId) return; // شناسه‌ی پیام نیست: کش نمی‌کنیم
  await env.DB.prepare(
    `INSERT INTO week_cache (key, chat_id, message_id, created_utc) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, chat_id) DO UPDATE SET message_id = excluded.message_id, created_utc = excluded.created_utc`
  ).bind(key, chatId, messageId, nowUtc()).run();
}

async function shortHash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function answerPublic(env, chatId, cmd, replyTo = null) {
  const startIso = await getSetting(env, "semester_start", "2026-09-12");
  const today = tehranToday();
  const text = buildAnswer(cmd, startIso, today);
  return sendCachedAnswer(env, chatId, `${cmd}|${today}`, text, () => sendFresh(env, chatId, text, replyTo));
}
