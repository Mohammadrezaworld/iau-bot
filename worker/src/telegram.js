// کمک‌های ارتباط با Telegram Bot API. توکن هیچ‌وقت در پیام خطا یا لاگ نوشته نمی‌شه.

// رنگ دکمه‌ها (Bot API 9.4): تأیید سبز، لغو و حذف قرمز، بقیه آبی. بر اساس متن دکمه تعیین می‌شه.
const BUTTON_STYLE = {
  "ثبت": "success",
  "تأیید و فعال‌سازی": "success",
  "لغو": "danger",
  "بستن": "danger",
  "نه": "danger",
  "بله، حذف": "danger",
};

export function styleMarkup(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((btn) => (btn.style ? btn : { ...btn, style: BUTTON_STYLE[btn.text] || "primary" }))
    ),
  };
}

// Callback IDs فقط یک‌بار جواب داده می‌شوند؛ cache محدود است تا isolate رشد نامحدود نکند.
const callbackAckCache = new Map();
const CALLBACK_ACK_CACHE_MAX = 256;

export async function tg(env, method, payload) {
  if (payload && payload.reply_markup) payload = { ...payload, reply_markup: styleMarkup(payload.reply_markup) };
  const callbackId = method === "answerCallbackQuery" && payload?.callback_query_id != null
    ? String(payload.callback_query_id)
    : null;
  if (callbackId && callbackAckCache.has(callbackId)) return callbackAckCache.get(callbackId);

  const request = (async () => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      // پاسخ خوانده نشد: معلوم نیست تلگرام کار رو انجام داده یا نه (مبهم)
      throw new Error(`telegram ${method} unreadable response (${res.status})`);
    }
    // یک callback قدیمی را نمی‌شود دوباره جواب داد؛ این خطای UI نباید کار تمام‌شده را ناموفق کند.
    if (method === "answerCallbackQuery" && Number(data.error_code || res.status) === 400 &&
        /query is too old|response timeout expired|query id is invalid/i.test(String(data.description || ""))) return null;
    // توضیح تلگرام (مثلاً chat not found) کمک می‌کنه علت خطا معلوم بشه؛ توکن هیچ‌وقت توش نیست
    if (!data.ok) {
      const err = new Error(`telegram ${method} failed (${data.error_code || res.status}): ${String(data.description || "").slice(0, 200)}`);
      // refused: تلگرام صریحاً رد کرده و کاری انجام نشده. خطاهای ۵xx مبهم حساب می‌شن.
      err.refused = res.status < 500;
      throw err;
    }
    return data.result;
  })();

  if (callbackId) {
    callbackAckCache.set(callbackId, request);
    if (callbackAckCache.size > CALLBACK_ACK_CACHE_MAX) {
      callbackAckCache.delete(callbackAckCache.keys().next().value);
    }
    try {
      return await request;
    } catch (err) {
      if (callbackAckCache.get(callbackId) === request) callbackAckCache.delete(callbackId);
      throw err;
    }
  }
  return request;
}

export async function sendMessage(env, chatId, text) {
  return tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

// فقط برای پیام‌هایی که متنشون با HTML ساخته شده و همه‌ی متن‌های ورودی escape شدن
export async function sendHtml(env, chatId, html) {
  return tg(env, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
}

// escape برای parse_mode=HTML تلگرام
export const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendJsonDocument(env, chatId, filename, obj, caption = "") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append(
    "document",
    new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }),
    filename
  );
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`telegram sendDocument failed (${data.error_code || res.status})`);
  return data.result;
}

// رمز webhook از توکن ربات مشتق می‌شه تا نیازی به Secret جدا نباشه.
// همین الگو در deploy-worker.yml هم استفاده می‌شه.
export async function webhookSecret(env) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// حذف پیام دستوری کاربر در گروه. فقط برای پیام‌هایی که ربات مجازه (دستورها)؛ خطا رو بی‌صدا رد می‌کنه.
export async function tryDeleteMessage(env, chatId, messageId) {
  try {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
    return true;
  } catch (err) {
    console.error("delete_error", err && err.message ? err.message : "unknown");
    return false;
  }
}
