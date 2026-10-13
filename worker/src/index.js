// Worker: webhook تلگرام، دریافت پست‌های اسکرپ‌شده (/ingest)، پشتیبان روزانه.
import { webhookSecret, tryDeleteMessage } from "./telegram.js";
import { handleAdminMessage, parseCmd, PUBLIC_CMDS, runPublic } from "./commands.js";
import { getSetting } from "./public.js";
import { sendReminders } from "./reminders.js";
import { handleCallback } from "./wizard.js";
import { handleKeywordCallback } from "./keywords.js";
import { handleHolidayCallback } from "./holidays.js";
import { handleJozvePost, handleJozveCommand, handleJozveCallback, handleJozveRemoveCallback } from "./jozve.js";
import { flushPosts } from "./channels.js";
import { isAdmin } from "./admin.js";
import { buildBackup } from "./admin.js";
import { sendJsonDocument, tg } from "./telegram.js";
import { handleMetroCommand, handleMetroCallback, handleMetroUploadCallback, cleanupMetroMessages } from "./metro.js";
import { handleScrapeReport, recordEvent, reportError, checkScrapeHealth, sendDailySummary, redact } from "./monitor.js";

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
  // اولین اجرای این کانال: پست‌های موجود فقط علامت می‌خورن و چیزی فرستاده نمی‌شه
  const prev = await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_runs WHERE source = ? AND channel = ?")
    .bind(source, channel).first();
  const firstRun = !prev || prev.n === 0;
  for (const p of posts) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO posts
         (source, channel, post_id, text, image_url, first_seen_utc, sent_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(source, channel, String(p.post_id), String(p.text || ""), String(p.image_url || ""), ts, firstRun ? ts : null)
      .run();
    if (res.meta && res.meta.changes > 0) newCount += 1;
  }

  await env.DB.prepare(
    `INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(source, channel, ts, newCount)
    .run();

  let delivered = null;
  if (!firstRun && newCount > 0) {
    try {
      delivered = await flushPosts(env, source, channel);
      if (delivered && delivered.sent) await recordEvent(env, source, channel, "delivered", String(delivered.sent));
    } catch (err) {
      await reportError(env, source, channel, "flush", err && err.message ? err.message : "unknown");
    }
  }
  return json({ ok: true, received: posts.length, new: newCount, delivered });
}

async function isOurGroup(env, chatId) {
  const groupId = await getSetting(env, "group_id", "");
  return groupId !== "" && String(chatId) === String(groupId);
}

// گروه: فقط دستورهای عمومی، با ضداسپم ۳۰ ثانیه‌ای برای هر کاربر (ادمین‌ها مستثنی)
async function handleGroupMessage(env, msg) {
  const { cmd } = parseCmd(msg.text);
  if (cmd === "/metro" && msg.from) return handleMetroCommand(env, msg);
  if (cmd === "/jozve" && msg.from) return handleJozveCommand(env, msg);
  if (!PUBLIC_CMDS.includes(cmd) || !msg.from) return;
  const userId = msg.from.id;
  // پیام دستوری کاربر بعد از پردازش پاک می‌شه (ربات فقط پیام‌های دستوری رو پاک می‌کنه)
  if (!(await isAdmin(env, userId))) {
    const nowS = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT last_utc FROM user_cooldowns WHERE user_id = ?").bind(userId).first();
    if (row && nowS - row.last_utc < 30) {
      await tryDeleteMessage(env, msg.chat.id, msg.message_id); // اسپم: بی‌صدا پاک می‌شه
      return;
    }
    await env.DB.prepare(
      "INSERT INTO user_cooldowns (user_id, last_utc) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_utc = excluded.last_utc"
    ).bind(userId, nowS).run();
  }
  await runPublic(env, msg.chat.id, cmd);
  await tryDeleteMessage(env, msg.chat.id, msg.message_id);
}

async function handleTelegramWebhook(request, env) {
  // Telegram رمز secret_token رو توی هدر می‌فرسته؛ اگه نبود، درخواست جعلیه
  const expected = await webhookSecret(env);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  try {
    if (update && update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || "";
      if (!cq.message || !cq.message.chat) return new Response("ok", { status: 200 });
      if (data.startsWith("j:") || data.startsWith("jk:")) {
        if (await isOurGroup(env, cq.message.chat.id)) await handleJozveCallback(env, cq);
      } else if (data.startsWith("m:")) {
        // منوی /metro در گروه؛ فقط همان گروه و فقط برای درخواست‌کننده (داخل handler چک می‌شه)
        if (await isOurGroup(env, cq.message.chat.id)) await handleMetroCallback(env, cq);
      } else if (data === "x:c" && cq.message.chat.type === "private" && (await isAdmin(env, cq.from.id))) {
        // بستن لیست‌های حذف و ویرایش در DM
        await tryDeleteMessage(env, cq.message.chat.id, cq.message.message_id);
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      } else if (cq.message.chat.type === "private" && (await isAdmin(env, cq.from.id))) {
        if (data.startsWith("mu:")) await handleMetroUploadCallback(env, cq);
        else if (data.startsWith("kw:")) await handleKeywordCallback(env, cq);
        else if (data.startsWith("hol:")) await handleHolidayCallback(env, cq);
        else if (data.startsWith("jrm:")) await handleJozveRemoveCallback(env, cq);
        else await handleCallback(env, cq);
      }
      return new Response("ok", { status: 200 });
    }
    // پست‌های کانال خصوصی جزوه (آپلود ادمین‌ها)
    if (update && update.channel_post) {
      await handleJozvePost(env, update.channel_post);
      return new Response("ok", { status: 200 });
    }
    const msg = update && update.message;
    if (msg && msg.chat) {
      if (msg.chat.type === "private") {
        await handleAdminMessage(env, msg);
      } else if (await isOurGroup(env, msg.chat.id)) {
        await handleGroupMessage(env, msg);
      }
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
    if (request.method === "POST" && url.pathname === "/scrape-report") {
      return handleScrapeReport(request, env);
    }
    return json({ ok: false, error: "not_found" }, 404);
  },

  // cron: پشتیبان روزانه برای مالک و یادآوری رویدادها (زمان‌ها در wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          if (event.cron === "* * * * *") {
            // هر دقیقه: پاک‌کردن پیام‌های موقت /metro، بررسی سلامت اسکرپ‌ها و گزارش روزانه.
            // هرکدوم جدا اجرا می‌شه تا خطای یکی، بقیه رو نبره.
            const tasks = { metro: cleanupMetroMessages, health: checkScrapeHealth, summary: sendDailySummary };
            const names = Object.keys(tasks);
            const results = await Promise.allSettled(names.map((name) => tasks[name](env)));
            results.forEach((r, i) => {
              if (r.status === "rejected") {
                console.error("minute_task_error", names[i], redact(env, r.reason && r.reason.message ? r.reason.message : "unknown"));
              }
            });
          } else if (event.cron === "30 2 * * *") {
            // ۰۶:۰۰ تهران: پست‌های دوره‌ی خواب یک‌جا
            const r = await flushPosts(env);
            if (r && r.sent) await recordEvent(env, "system", "", "delivered", String(r.sent));
          } else if (event.cron === "30 20 * * *") {
            const backup = await buildBackup(env);
            await sendJsonDocument(env, env.OWNER_ID, "iaut-backup.json", backup, "پشتیبان روزانه");
          } else {
            await sendReminders(env, event.cron);
          }
        } catch (err) {
          const msg = err && err.message ? err.message : "unknown";
          console.error("cron_error", redact(env, msg));
          await reportError(env, "system", "", "cron", msg);
        }
      })()
    );
  },
};
