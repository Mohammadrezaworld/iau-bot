// Worker: webhook تلگرام، دریافت پست‌های اسکرپ‌شده (/ingest)، پشتیبان روزانه.
import { webhookSecret, tryDeleteMessage } from "./telegram.js";
import { handleAdminMessage, handleDmUser, parseCmd, PUBLIC_CMDS, runPublic } from "./commands.js";
import { getSetting } from "./public.js";
import { tehranToday } from "./calendar.js";
import { sendReminders } from "./reminders.js";
import { handleCallback } from "./wizard.js";
import { handleKeywordCallback } from "./keywords.js";
import { handleHolidayCallback } from "./holidays.js";
import { handleJozvePost, handleJozveCommand, handleJozveCallback, handleJozveRemoveCallback, handleDmCallback, groupMovedGuide, dmIsMember, DM_NOT_MEMBER } from "./jozve.js";
import { flushPosts, cleanPostText, inTehranQuietHours } from "./channels.js";
import { isAdmin } from "./admin.js";
import { buildBackup } from "./admin.js";
import { sendJsonDocument, tg } from "./telegram.js";
import { handleMetroCallback, handleMetroUploadCallback, cleanupMetroMessages } from "./metro.js";
import { handleScrapeReport, recordEvent, reportError, checkScrapeHealth, sendDailySummary, redact } from "./monitor.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const nowUtc = () => Math.floor(Date.now() / 1000);

const FLOOD_LIMIT = 5;

// مشخص می‌کنه پست بله جدیده (برای ارسال) یا قدیمی/بی‌تاریخ (فقط ثبت می‌شه)
function baleCategory(p, today) {
  if (!p.post_date) return "unknown";
  if (p.post_date < today) return "old";
  return "send";
}

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
  let sendCount = 0;
  const ts = nowUtc();
  const today = tehranToday();
  // اولین اجرای این کانال: پست‌های موجود فقط علامت می‌خورن و چیزی فرستاده نمی‌شه
  const prev = await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_runs WHERE source = ? AND channel = ?")
    .bind(source, channel).first();
  const firstRun = !prev || prev.n === 0;
  // حالت آزمایشی بله (پیش‌فرض روشن): هیچ پستی به گروه نمی‌ره، فقط گزارش به مالک
  const dryRun = source === "bale" && (await getSetting(env, "bale_dry_run", "1")) === "1";
  // متن‌های قبلی این کانال (بدون فوتر) تا پست تکراری با شماره‌ی بازدید متفاوت دوباره ارسال نشه
  const { results: known } = await env.DB.prepare(
    "SELECT text FROM posts WHERE source = ? AND channel = ? ORDER BY id DESC LIMIT 400"
  ).bind(source, channel).all();
  const seenText = new Set(known.map((r) => cleanPostText(r.text)).filter(Boolean));
  const report = { send: [], old: 0, unknown: 0 };

  for (const p of posts) {
    const key = cleanPostText(p.text);
    if (key && seenText.has(key)) continue;
    if (key) seenText.add(key);
    const category = source === "bale" ? baleCategory(p, today) : "send";
    // قدیمی، بی‌تاریخ، حالت آزمایشی و اولین اجرا: فقط ثبت می‌شن و ارسال نمی‌شن
    const markSent = firstRun || category !== "send" || dryRun;
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO posts
         (source, channel, post_id, text, image_url, first_seen_utc, sent_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(source, channel, String(p.post_id), String(p.text || ""), String(p.image_url || ""), ts, markSent ? ts : null)
      .run();
    if (res.meta && res.meta.changes > 0) {
      newCount += 1;
      if (category === "send") {
        sendCount += 1;
        if (report.send.length < 5) report.send.push(String(p.text || "").slice(0, 120));
      } else if (category === "old") report.old += 1;
      else report.unknown += 1;
    }
  }

  await env.DB.prepare(
    `INSERT INTO scrape_runs (source, channel, ran_at_utc, new_count, ok)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(source, channel, ts, newCount)
    .run();

  // محافظ سیل: اگه یک اسکرپ بیش از حد پست قابل ارسال از بله بیاره، به گروه نمی‌ره
  const held = source === "bale" && !firstRun && !dryRun && sendCount > FLOOD_LIMIT;
  if (held) {
    await env.DB.prepare(
      "UPDATE posts SET sent_at_utc = ? WHERE source = ? AND channel = ? AND sent_at_utc IS NULL AND first_seen_utc = ?"
    ).bind(ts, source, channel, ts).run();
    await recordEvent(env, source, channel, "error", `flood: ${sendCount} پست جدید ثبت شد ولی به گروه نرفت`);
    await notifyOwner(env, `پست‌های جدید بله (${channel}): ${sendCount} پست یک‌جا رسید. برای امنیت به گروه نرفت. اگه باید فرستاده بشه، بگو تا دستی بفرستم.`);
  }

  // گزارش حالت آزمایشی: هر بار که پست جدیدی باشه، برای مالک خلاصه‌ی تصمیم‌ها
  if (source === "bale" && !firstRun && dryRun && newCount > 0) {
    const lines = [
      `حالت آزمایشی بله (${channel}): ${newCount} پست جدید.`,
      `ارسال می‌شد: ${sendCount} · قدیمی: ${report.old} · بدون تاریخ: ${report.unknown}`,
      ...report.send.map((t) => `• ${t}`),
      "این فقط گزارش بود و به گروه چیزی نرفت. با /bale_mode live واقعی می‌شه.",
    ];
    await notifyOwner(env, lines.join("\n"));
  }

  let delivered = null;
  if (!firstRun && !dryRun && !held && sendCount > 0) {
    try {
      delivered = await flushPosts(env, source, channel);
      if (delivered && delivered.sent) await recordEvent(env, source, channel, "delivered", String(delivered.sent));
    } catch (err) {
      await reportError(env, source, channel, "flush", err && err.message ? err.message : "unknown");
    }
  }
  return json({ ok: true, received: posts.length, new: newCount, send: sendCount, dry_run: dryRun, held, delivered });
}

async function notifyOwner(env, text) {
  try {
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text, disable_web_page_preview: true });
  } catch (err) {
    console.error("owner_notify", err && err.message ? err.message : "unknown");
  }
}

async function isOurGroup(env, chatId) {
  const groupId = await getSetting(env, "group_id", "");
  return groupId !== "" && String(chatId) === String(groupId);
}

// پیام یا دکمه‌ی گروه اصلی در ساعت سکوت (۰۲ تا ۰۶ تهران) → بی‌صدا نادیده گرفته می‌شه
async function groupSilenced(env, update) {
  const chat = (update.message || update.edited_message || (update.callback_query && update.callback_query.message) || {}).chat;
  if (!chat || chat.type === "private") return false;
  if (!(await isOurGroup(env, chat.id))) return false;
  return inTehranQuietHours(env);
}

const GROUP_MOVED = ["/metro", "/call", "/links", "/events", "/next", "/term", "/left", "/updates"];
// گروه: فقط دستورهای عمومی، با ضداسپم ۳۰ ثانیه‌ای برای هر کاربر (ادمین‌ها مستثنی)
async function handleGroupMessage(env, msg) {
  const { cmd } = parseCmd(msg.text);
  // دستورهای منتقل‌شده به پیوی: فقط راهنما (/updates بی‌صدا پاک می‌شه)
  if (GROUP_MOVED.includes(cmd) && msg.from) {
    if (cmd === "/updates") return tryDeleteMessage(env, msg.chat.id, msg.message_id);
    return groupMovedGuide(env, msg.chat.id, msg.message_id);
  }
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

// پردازش یک update: هر خطایی بیرون پرت می‌شه تا handleTelegramWebhook تصمیم بگیره
async function dispatchUpdate(env, update) {
  if (update && update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";
    if (!cq.message || !cq.message.chat) return;
    if (data.startsWith("d:") && cq.message.chat.type === "private") {
      // منوی شخصی جزوه‌ها در پیوی (کاربر عادی و ادمین)
      await handleDmCallback(env, cq);
    } else if (data.startsWith("j:") || data.startsWith("jk:")) {
      if (await isOurGroup(env, cq.message.chat.id)) await handleJozveCallback(env, cq);
    } else if (data.startsWith("m:")) {
      // منوی /metro: در پیوی (کاربر عضو) یا گروه قدیمی؛ فقط برای درخواست‌کننده (داخل handler چک می‌شه)
      if (cq.message.chat.type === "private") {
        if (await dmIsMember(env, cq.from.id)) await handleMetroCallback(env, cq);
        else await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: DM_NOT_MEMBER, show_alert: true });
      } else if (await isOurGroup(env, cq.message.chat.id)) {
        await handleMetroCallback(env, cq);
      }
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
    return;
  }
  // پست‌های کانال خصوصی جزوه (آپلود ادمین‌ها)
  if (update && update.channel_post) {
    await handleJozvePost(env, update.channel_post);
    return;
  }
  const msg = update && update.message;
  if (msg && msg.chat) {
    if (msg.chat.type === "private") {
      // کاربر عادی: فقط /start و /jozve؛ بقیه‌ی پیام‌ها بی‌صدا نادیده گرفته می‌شن
      if (!(await handleDmUser(env, msg))) await handleAdminMessage(env, msg);
    } else if (await isOurGroup(env, msg.chat.id)) {
      await handleGroupMessage(env, msg);
    }
  }
}

// صف idempotent: هر update_id فقط یک بار موفق پردازش می‌شه.
// حالت‌ها: processing (در حال پردازش) · done (موفق) · failed (شکست؛ دوباره می‌شه امتحان کرد)
const MAX_UPDATE_ATTEMPTS = 3;
const STALE_PROCESSING_S = 90;
const PROCESSED_KEEP_S = 7 * 86400;

async function claimUpdate(env, id) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM processed_updates WHERE state = 'done' AND at_utc < ?").bind(now - PROCESSED_KEEP_S).run();
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_updates (update_id, state, attempts, at_utc) VALUES (?, 'processing', 1, ?)"
  ).bind(id, now).run();
  if (ins.meta.changes === 1) return "claimed";
  const row = await env.DB.prepare("SELECT state, attempts, at_utc FROM processed_updates WHERE update_id = ?").bind(id).first();
  if (!row) return "busy";
  if (row.state === "done") return "skip";
  if (row.attempts >= MAX_UPDATE_ATTEMPTS) {
    console.error("update_dropped", id);
    return "skip";
  }
  if (row.state === "processing" && now - row.at_utc < STALE_PROCESSING_S) return "busy";
  // بازپردازش: فقط اگه وضعیت و تعداد تلاش هنوز همون چیزی باشه که خوندیم (جلوگیری از دو پردازش هم‌زمان)
  const upd = await env.DB.prepare(
    "UPDATE processed_updates SET state = 'processing', attempts = attempts + 1, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
  ).bind(now, id, row.state, row.attempts).run();
  return upd.meta.changes === 1 ? "claimed" : "busy";
}

async function markUpdate(env, id, state) {
  await env.DB.prepare("UPDATE processed_updates SET state = ?, at_utc = ? WHERE update_id = ?")
    .bind(state, Math.floor(Date.now() / 1000), id).run();
}

async function handleTelegramWebhook(request, env) {
  // Telegram رمز secret_token رو توی هدر می‌فرسته؛ اگه نبود، درخواست جعلیه
  const expected = await webhookSecret(env);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  // ساعت سکوت گروه: هیچ پاسخ یا واکنشی به پیام/دکمه‌ی گروه داده نمی‌شه (دستورهای قدیمی هم)
  if (update && (await groupSilenced(env, update))) return new Response("ok", { status: 200 });

  const id = update && Number.isSafeInteger(update.update_id) ? update.update_id : null;
  if (id !== null) {
    const claim = await claimUpdate(env, id);
    // busy: یه پردازش دیگه همین update رو داره؛ ۵۰۰ تا تلگرام بعداً دوباره بفرسته
    if (claim === "busy") return new Response("busy", { status: 500 });
    if (claim === "skip") return new Response("ok", { status: 200 });
  }
  try {
    await dispatchUpdate(env, update);
  } catch (err) {
    console.error("webhook_error", err && err.message ? err.message : "unknown");
    if (id !== null) {
      // شکست: علامت failed، و ۵۰۰ تا تلگرام دوباره بفرسته (تا سقف تلاش‌ها)
      await markUpdate(env, id, "failed");
      return new Response("retry", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }
  if (id !== null) await markUpdate(env, id, "done");
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
