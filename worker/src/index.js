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
import { cleanPostText, inTehranQuietHours, handleStatusRefresh } from "./channels.js";
import { prepareBatch, handleBatchCallback, expireBatches, listStalledBatches, approveBatch } from "./batches.js";
import { scrapeSettingsCommand, handleScrapeSettingsCallback } from "./scrape_mode.js";
import { ADMIN_MENU } from "./admin_menu.js";
import { isAdmin, isOwner } from "./admin.js";
import { buildBackup } from "./admin.js";
import { sendJsonDocument, tg } from "./telegram.js";
import { handleMetroCallback, handleMetroUploadCallback, cleanupMetroMessages } from "./metro.js";
import { handleScrapeReport, recordEvent, reportError, checkScrapeHealth, sendDailySummary, redact } from "./monitor.js";
import { claimUpdate, markOutcome, markDoneWithRetry, notifyNeedsReview, retryUpdate, resolveUpdate, listReview, describeReviewRow, MAX_AUTO_ATTEMPTS, isUpdateId } from "./updates.js";

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
      if (markSent) {
        const why = firstRun ? "baseline" : dryRun ? "dry_run" : category === "old" ? "old" : "undated";
        await env.DB.prepare("INSERT OR IGNORE INTO post_outcomes (post_id, outcome, at_utc) SELECT id, ?, ? FROM posts WHERE source = ? AND channel = ? AND post_id = ?")
          .bind(why, ts, source, channel, String(p.post_id)).run();
      }
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
      "INSERT OR IGNORE INTO post_outcomes (post_id, outcome, at_utc) SELECT id, 'held_flood', ? FROM posts WHERE source = ? AND channel = ? AND sent_at_utc IS NULL AND first_seen_utc = ?"
    ).bind(ts, source, channel, ts).run();
    await env.DB.prepare(
      "UPDATE posts SET sent_at_utc = ? WHERE source = ? AND channel = ? AND sent_at_utc IS NULL AND first_seen_utc = ?"
    ).bind(ts, source, channel, ts).run();
    await recordEvent(env, source, channel, "error", `flood: ${sendCount} پست جدید ثبت شد ولی به گروه نرفت`);
    await notifyOwner(env, `پست‌های جدید بله (${channel}): ${sendCount} پست یک‌جا رسید. برای امنیت به گروه نرفت و کنار گذاشته شدن. در این نسخه مسیر ارسال مجدد ندارن؛ وضعیتشون در /scrape_status ثبت شده.`);
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
      delivered = await prepareBatch(env);
      if (delivered && delivered.prepared) await recordEvent(env, source, channel, "delivered", `batch:${delivered.prepared}`);
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
async function dispatchUpdate(env, update, ctx = null) {
  // ارسال خودکار دسته: همان مسیر ایمن ادامه (claim/lease و خطاهای مبهم)
  if (update && update.kind === "auto_batch") {
    if (!ctx) return "این دسته را از /review با «ادامه» بزن.";
    // هر اجرای خودکار (حتی تلاش مجدد از /review) فقط با مجوز همان فعال‌سازی ادامه می‌دهد
    return approveBatch(env, { ...ctx, auto: true, epoch: Number(update.epoch) }, Number(update.batch));
  }
  if (update && update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";
    if (data.startsWith("sb:")) {
      // دسته‌ی اسکرپ: فقط مالک در پیوی
      if (cq.message && cq.message.chat && cq.message.chat.type === "private" && (await isOwner(env, cq.from.id))) {
        return handleBatchCallback(env, cq, ctx);
      }
      return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    }
    if (data.startsWith("ss:")) {
      // پنل حالت اسکرپ: فقط مالک در پیوی؛ کنترل نهایی در handler
      if (cq.message && cq.message.chat && cq.message.chat.type === "private" && (await isOwner(env, cq.from.id))) {
        return handleScrapeSettingsCallback(env, cq, ctx);
      }
      return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    }
    if (data.startsWith("rv:")) {
      // فهرست بررسی: فقط مالک
      if (cq.message && cq.message.chat && cq.message.chat.type === "private" && (await isOwner(env, cq.from.id))) {
        return handleReviewCallback(env, cq);
      }
      return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    }
    if (!cq.message || !cq.message.chat) return;
    if (data.startsWith("d:") && cq.message.chat.type === "private") {
      // منوی شخصی جزوه‌ها در پیوی (کاربر عادی و ادمین)
      await handleDmCallback(env, cq);
    } else if (data.startsWith("j:") || data.startsWith("jk:")) {
      if (await isOurGroup(env, cq.message.chat.id)) await handleJozveCallback(env, cq, ctx);
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
      if (data === "st:r") return handleStatusRefresh(env, cq);
      if (data.startsWith("am:")) {
        // دکمه‌ی منوی ادمین: همان دستور متنی از مسیر عادی پیام اجرا می‌شه (مجوز مالک و ادمین همون‌جا چک می‌شه)
        const item = ADMIN_MENU[Number(data.slice(3))];
        if (item) {
          const nowMs = Date.now();
          await dispatchUpdate(env, { message: { message_id: -nowMs, date: Math.floor(nowMs / 1000), chat: cq.message.chat, from: cq.from, text: item.cmd } });
        }
        return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
      }
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
      if (msg.from && (await isOwner(env, msg.from.id)) && ["/review", "/retry_update", "/resolve_update", "/scrape_settings"].includes(parseCmd(msg.text).cmd)) {
        return handleOwnerCommand(env, msg);
      }
      // کاربر عادی: فقط /start و /jozve؛ بقیه‌ی پیام‌ها بی‌صدا نادیده گرفته می‌شن
      if (!(await handleDmUser(env, msg))) await handleAdminMessage(env, msg);
    } else if (await isOurGroup(env, msg.chat.id)) {
      await handleGroupMessage(env, msg);
    }
  }
}

// صف update (ماژول updates.js) و اثرها (ماژول effects.js)
// - تضمین: DB effects با کلید پایدار تکرار نمی‌شن؛ ارسال تلگرام حداکثر یک تلاش خودکار دارد و نتیجه‌ی مبهم به مالک می‌رسه (exactly-once نیست).
// - اثر نامشخص (AmbiguousError) → needs_review بدون تلاش خودکار؛ تصمیم با مالک (/resolve_update)
// - lease از دست رفته (LeaseLostError) → هیچ نوشتنی نمی‌کنه و ۲۰۰ برمی‌گردونه
// - ۲۰۰ بعد از موفقیت فقط وقتی برمی‌گرده که تلگرام تکرار نکنه؛ اگه ثبت done شکست بخوره، ردیف در /review دیده می‌شه
async function handleTelegramWebhook(request, env) {
  // Telegram رمز secret_token رو توی هدر می‌فرسته؛ اگه نبود، درخواست جعلیه
  const expected = await webhookSecret(env);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  // ساعت سکوت گروه: هیچ پاسخ یا واکنشی به پیام/دکمه‌ی گروه داده نمی‌شه (رفتار فعلی؛ تغییر نکرده)
  if (update && (await groupSilenced(env, update))) return new Response("ok", { status: 200 });

  const id = update && Number.isSafeInteger(update.update_id) ? update.update_id : null;
  let ctx = null;
  let attempts = 1;
  if (id !== null) {
    // اگه خطای DB اینجا پرت بشه، هنوز هیچ کاری انجام نشده، پس ۵۰۰ امنه و تلگرام دوباره می‌فرسته
    const claim = await claimUpdate(env, id, JSON.stringify(update));
    if (claim.status === "busy") return new Response("busy", { status: 500 });
    if (claim.status === "skip") return new Response("ok", { status: 200 });
    if (claim.status === "exhausted") {
      console.error("update_needs_review", id);
      await notifyNeedsReview(env, id, update, "تلاش‌های خودکار تمام شد", "exhausted");
      return new Response("ok", { status: 200 });
    }
    ctx = { updateId: id, lease: claim.lease };
    attempts = claim.attempts;
  }

  try {
    await dispatchUpdate(env, update, ctx);
  } catch (err) {
    if (err && err.name === "LeaseLostError") {
      // اجرای دیگه‌ای مالک شده؛ این اجرا چیزی نمی‌نویسه
      console.error("lease_lost_stop", id);
      return new Response("ok", { status: 200 });
    }
    const msg = err && err.message ? err.message : "unknown";
    console.error("webhook_error", msg);
    if (id === null) return new Response("ok", { status: 200 });
    if (err && err.name === "AmbiguousError") {
      // نتیجه‌ی یک اثر نامشخصه: تلاش خودکار نمی‌کنیم
      await markOutcome(env, id, ctx.lease, "needs_review", msg, "ambiguous").catch(() => console.error("mark_outcome_failed", id));
      await notifyNeedsReview(env, id, update, msg, "ambiguous");
      return new Response("ok", { status: 200 });
    }
    // شکست عادی: با اثرهای ثبت‌شده، تلاش دوباره امنه. تلاش آخر → needs_review
    const last = attempts >= MAX_AUTO_ATTEMPTS;
    try {
      await markOutcome(env, id, ctx.lease, last ? "needs_review" : "failed", msg, last ? "exhausted" : "error");
    } catch (dbErr) {
      console.error("mark_outcome_failed", id);
    }
    if (last) {
      await notifyNeedsReview(env, id, update, msg, "exhausted");
      return new Response("ok", { status: 200 });
    }
    return new Response("retry", { status: 500 });
  }
  if (id !== null) {
    if (!(await markDoneWithRetry(env, id, ctx.lease))) console.error("done_write_pending", id);
  }
  return new Response("ok", { status: 200 });
}

// دستورهای مالک در پیوی: /review (فهرست)، /retry_update <id>، /resolve_update <id> applied|not_applied
async function handleOwnerCommand(env, msg) {
  const { cmd, arg } = parseCmd(msg.text);
  const chatId = msg.chat.id;
  if (cmd === "/review") {
    const rows = await listReview(env);
    const stalled = await listStalledBatches(env);
    if (!rows.length && !stalled.length) return tg(env, "sendMessage", { chat_id: chatId, text: "موردی نیازمند بررسی نیست." });
    const parts = [];
    const inline_keyboard = [];
    if (rows.length) {
      parts.push(["موارد نیازمند بررسی:", "", ...rows.map(describeReviewRow)].join("\n\n"));
      for (const r of rows) inline_keyboard.push([
        { text: "تلاش مجدد", callback_data: `rv:r:${r.update_id}` },
        { text: "اعمال شد", callback_data: `rv:a:${r.update_id}` },
        { text: "انجام نشد", callback_data: `rv:n:${r.update_id}` },
      ]);
    }
    // دسته‌ی ناقص: مستقل از پیش‌نمایش قدیمی؛ ادامه فقط با دکمه‌ی مالک و فقط برای بخش‌های نرفته
    for (const b of stalled) {
      parts.push(`دسته‌ی ${b.id} ناقص مانده: ${b.left_n} پست و ${b.photo_n} بخش عکس نرفته${b.amb_n ? ` (${b.amb_n} مورد مبهم؛ اول در فهرست بالا تعیین کن)` : ""}.`);
      inline_keyboard.push([{ text: `ادامه‌ی دسته ${b.id}`, callback_data: `sb:c:${b.id}` }]);
      if (b.photo_n) inline_keyboard.push([{ text: `ادامه بدون عکس‌های دسته ${b.id}`, callback_data: `sb:k:${b.id}` }]);
    }
    return tg(env, "sendMessage", { chat_id: chatId, text: parts.join("\n\n"), reply_markup: { inline_keyboard }, disable_web_page_preview: true });
  }
  if (cmd === "/scrape_settings") {
    return scrapeSettingsCommand(env, chatId);
  }
  if (cmd === "/retry_update") {
    const id = Number(arg.trim());
    const text = isUpdateId(id) ? await retryUpdate(env, id, dispatchUpdate) : "فرمت: /retry_update <شناسه>";
    return tg(env, "sendMessage", { chat_id: chatId, text });
  }
  if (cmd === "/resolve_update") {
    const [rawId, decision] = arg.trim().split(/\s+/);
    const id = Number(rawId);
    if (!isUpdateId(id) || !["applied", "not_applied"].includes(decision)) {
      return tg(env, "sendMessage", { chat_id: chatId, text: "فرمت: /resolve_update <شناسه> applied|not_applied\napplied: اثر انجام شده · not_applied: اثری نبوده (بعدش می‌شه دوباره اجرا کرد)" });
    }
    return tg(env, "sendMessage", { chat_id: chatId, text: await resolveUpdate(env, id, decision) });
  }
  return false;
}

// دکمه‌های فهرست /review (فقط مالک)
async function handleReviewCallback(env, cq) {
  const [, action, rawId] = String(cq.data).split(":");
  const id = Number(rawId);
  let text;
  if (!isUpdateId(id)) text = "نامعتبر";
  else if (action === "r") text = await retryUpdate(env, id, dispatchUpdate);
  else if (action === "a") text = await resolveUpdate(env, id, "applied");
  else if (action === "n") text = await resolveUpdate(env, id, "not_applied");
  else text = "نامعتبر";
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: true });
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
            const tasks = { metro: cleanupMetroMessages, health: checkScrapeHealth, summary: sendDailySummary, batches: expireBatches };
            const names = Object.keys(tasks);
            const results = await Promise.allSettled(names.map((name) => tasks[name](env)));
            results.forEach((r, i) => {
              if (r.status === "rejected") {
                console.error("minute_task_error", names[i], redact(env, r.reason && r.reason.message ? r.reason.message : "unknown"));
              }
            });
          } else if (event.cron === "30 2 * * *") {
            // ۰۶:۰۰ تهران: پست‌های دوره‌ی خواب یک‌جا
            const r = await prepareBatch(env);
            if (r && r.prepared) await recordEvent(env, "system", "", "delivered", `batch:${r.prepared}`);
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
