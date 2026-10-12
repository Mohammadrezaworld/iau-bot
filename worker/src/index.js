// Worker: webhook تلگرام، دریافت پست‌های اسکرپ‌شده (/ingest)، پشتیبان روزانه.
import { webhookSecret } from "./telegram.js";
import { handleAdminMessage } from "./commands.js";
import { buildBackup } from "./admin.js";
import { sendJsonDocument } from "./telegram.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const nowUtc = () => Math.floor(Date.now() / 1000);

async function handleIngest(request, env) {
  // فقط GitHub Actions با رمز مشترک می‌تونه پست بفرسته
  if (request.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await request.json();
  const source = String(body.source || "");
  const channel = String(body.channel || "");
  const posts = Array.isArray(body.posts) ? body.posts : [];

  if (!["bale", "telegram"].includes(source) || !channel) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  let newCount = 0;
  const ts = nowUtc();
  for (const p of posts) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO posts
         (source, channel, post_id, text, image_url, first_seen_utc)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(source, channel, String(p.post_id), String(p.text || ""), String(p.image_url || ""), ts)
      .run();
    if (res.meta && res.meta.changes > 0) newCount += 1;
  }

  await env.DB.prepare(
    `INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(source, channel, ts, newCount)
    .run();

  return json({ ok: true, received: posts.length, new: newCount });
}

async function handleTelegramWebhook(request, env) {
  // Telegram رمز secret_token رو توی هدر می‌فرسته؛ اگه نبود، درخواست جعلیه
  const expected = await webhookSecret(env);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  try {
    // فعلاً فقط DM. پیام‌های گروه در مرحله‌ی بعد اضافه می‌شن.
    if (update && update.message && update.message.chat && update.message.chat.type === "private") {
      await handleAdminMessage(env, update.message);
    }
  } catch (err) {
    // خطا رو لاگ می‌کنیم ولی 200 برمی‌گردونیم تا تلگرام بی‌خودی تکرار نکنه
    console.error("webhook_error", err && err.message ? err.message : "unknown");
  }
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, time_utc: nowUtc() });
    }
    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/tg-webhook") {
      return handleTelegramWebhook(request, env);
    }
    return json({ ok: false, error: "not_found" }, 404);
  },

  // پشتیبان روزانه برای مالک (cron در wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const backup = await buildBackup(env);
          await sendJsonDocument(env, env.OWNER_ID, "iaut-backup.json", backup, "پشتیبان روزانه");
        } catch (err) {
          console.error("backup_error", err && err.message ? err.message : "unknown");
        }
      })()
    );
  },
};
