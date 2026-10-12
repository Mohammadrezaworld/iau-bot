// کمک‌های ارتباط با Telegram Bot API. توکن هیچ‌وقت در پیام خطا یا لاگ نوشته نمی‌شه.

export async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`telegram ${method} failed (${data.error_code || res.status})`);
  return data.result;
}

export async function sendMessage(env, chatId, text) {
  return tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

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
