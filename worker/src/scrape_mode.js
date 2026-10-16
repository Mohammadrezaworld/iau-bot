// پنل مالک: حالت ارسال خبرهای اسکرپ (تأیید دستی / ارسال خودکار / توقف انتشار).
// فقط اسکرپ؛ یادآوری رویدادها مستقل است. تغییر فقط برای مالک، در هر callback نهایی بررسی می‌شه.
import { tg } from "./telegram.js";
import { isOwner, audit } from "./admin.js";
import { scrapeMode, readModeSnapshot, autoAllowed } from "./channels.js";
import { prepareBatch } from "./batches.js";
import { setOutcome } from "./outcomes.js";

const nowS = () => Math.floor(Date.now() / 1000);
const LABEL = { manual: "تأیید دستی", auto: "ارسال خودکار", stop: "توقف انتشار" };

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value)).run();
}

// پست‌های معوق کنار گذاشته می‌شن (همان رفتار /scrape_resume بدون all)؛ دسته‌های منتظر رد می‌شن.
// دسته‌های sending (شامل بخش‌های ارسال‌نشده و مبهم) دست نمی‌خورن؛ تصمیمشون با مالک در /review است.
const NOT_IN_SENDING = "id NOT IN (SELECT bi.post_id FROM scrape_batch_items bi JOIN scrape_batches b ON b.id = bi.batch_id WHERE b.state = 'sending')";
async function skipBacklog(env) {
  const { results } = await env.DB.prepare(`SELECT id FROM posts WHERE sent_at_utc IS NULL AND ${NOT_IN_SENDING}`).all();
  await setOutcome(env, results.map((r) => r.id), "skipped_resume");
  await env.DB.prepare(`UPDATE posts SET sent_at_utc = ? WHERE sent_at_utc IS NULL AND ${NOT_IN_SENDING}`).bind(nowS()).run();
  await env.DB.prepare("UPDATE scrape_batches SET state = 'rejected' WHERE state = 'pending'").run();
}

// نوشتن حالت در یک تراکنش (D1 batch): cutoff و حالت یا با هم نوشته می‌شن یا هیچ‌کدام.
// خواننده (readModeSnapshot) هرگز auto=1 را با cutoff قدیمی نمی‌بیند.
async function writeMode(env, { auto, paused, since }) {
  const up = (k, v) => env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v));
  const stmts = [];
  if (since !== undefined) stmts.push(up("scrape_auto_since", since));
  if (auto !== undefined) stmts.push(up("scrape_auto", auto ? "1" : "0"));
  if (paused !== undefined) stmts.push(up("scrape_paused", paused ? "1" : "0"));
  await env.DB.batch(stmts);
}

// تغییر حالت. actorId باید مالک باشه (بررسی در همین تابع هم تکرار می‌شه).
// backlog (فقط وقتی از توقف خارج می‌شیم): 'new' = معوق‌ها کنار گذاشته؛ 'sug' = معوق‌ها برای تأیید پیشنهاد.
// تغییر حالت هیچ دسته‌ی sending یا نتیجه‌ی مبهمی را آزاد یا دوباره ارسال نمی‌کند.
export async function changeMode(env, actorId, target, backlog = null) {
  if (!(await isOwner(env, actorId))) return { ok: false, text: "این کار فقط برای مالک است." };
  if (!["manual", "auto", "stop"].includes(target)) return { ok: false, text: "حالت نامعتبر." };
  const from = await scrapeMode(env);
  if (from === target) return { ok: true, text: `همین حالت از قبل فعال است: ${LABEL[target]}.` };
  if (target === "auto" && !autoAllowed(env)) return { ok: false, text: LOCKED_TEXT };
  if (from === "stop" && target !== "stop") {
    if (!["new", "sug"].includes(backlog)) return { ok: false, text: "اول مشخص کن پست‌های معوق چه شوند." };
    if (backlog === "new") await skipBacklog(env);
  }
  if (target === "auto") await writeMode(env, { since: nowS(), auto: true, paused: false });
  else if (target === "stop") await writeMode(env, { paused: true });
  else await writeMode(env, { auto: false, paused: false });
  await audit(env, actorId, "scrape_mode", `${from}->${target}${backlog ? ` backlog=${backlog}` : ""}`);
  if (from === "stop" && backlog === "sug") await prepareBatch(env).catch(() => {});
  return { ok: true, text: `حالت شد: ${LABEL[target]}.` };
}

// تأیید دوم خودکار: نشانه‌ی یک‌بار مصرف و زمان‌دار. انصراف یا هر دکمه‌ی دیگر آن را باطل می‌کند.
const TOKEN_TTL_S = 300;
const LOCKED_TEXT = "ارسال خودکار پس از پایان آزمایش قابل فعال‌سازی است.";
// هر صدور یک nonce تصادفی یکتا دارد؛ زمان فقط برای انقضاست. صدور جدید یا انصراف، nonce قبلی را بی‌اعتبار می‌کند.
async function issueAutoToken(env) {
  const nonce = crypto.randomUUID();
  await setSetting(env, "scrape_auto_token", `${nonce}|${nowS()}`);
  return nonce;
}
async function consumeAutoToken(env, nonce) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(nonce || ""))) return false;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'scrape_auto_token'").first();
  const [stored, issued] = String((row && row.value) || "").split("|");
  if (stored !== nonce || nowS() - Number(issued) > TOKEN_TTL_S) return false;
  // مصرف اتمیک: فقط همان مقدار خوانده‌شده پاک می‌شود
  const r = await env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'scrape_auto_token' AND value = ?").bind(String(row.value)).run();
  return r.meta.changes === 1;
}
async function clearAutoToken(env) {
  await setSetting(env, "scrape_auto_token", "");
}

// /scrape_resume (فقط مالک): همان سرویس پنل. پیش‌فرض: معوق‌ها کنار گذاشته، فقط پست‌های جدید.
// all: معوق‌ها فقط پیشنهاد برای تأیید؛ هیچ‌وقت خودکار منتشر نمی‌شوند.
export async function resumeCommand(env, chatId, userId, arg, owner) {
  if (!owner) return tg(env, "sendMessage", { chat_id: chatId, text: "این دستور فقط برای مالک ربات است." });
  const snap = await readModeSnapshot(env);
  if (snap.mode !== "stop") return tg(env, "sendMessage", { chat_id: chatId, text: `ارسال به گروه الان متوقف نیست (حالت: ${LABEL[snap.mode]}). تغییر حالت از /scrape_settings.` });
  const all = String(arg || "").trim().toLowerCase() === "all";
  const r = await changeMode(env, userId, "manual", all ? "sug" : "new");
  const note = all
    ? "معوق‌ها فقط برای تأیید تو پیش‌نمایش می‌شن؛ هیچ‌کدام خودکار منتشر نمی‌شود."
    : "معوق‌های دوران توقف کنار گذاشته شدند؛ فقط پست‌های جدید از این به بعد پیشنهاد می‌شن.";
  return tg(env, "sendMessage", { chat_id: chatId, text: r.ok ? `${r.text} ${note}` : r.text, disable_web_page_preview: true });
}

async function panelText(env) {
  const mode = await scrapeMode(env);
  const pending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_batches WHERE state = 'pending'").first()).n;
  const stalled = (await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_batches WHERE state = 'sending'").first()).n;
  const mark = (m) => (mode === m ? "✓ " : "");
  return [
    "تنظیمات ارسال خبرهای اسکرپ",
    `حالت فعلی: ${LABEL[mode]}`,
    "",
    `${mark("manual")}• تأیید دستی: هر دسته‌ی جدید برای تو پیش‌نمایش می‌شه؛ فقط با دکمه‌ی «ارسال به گروه» می‌ره.`,
    `${mark("auto")}• ارسال خودکار: پست‌های جدیدی که بعد از فعال‌سازی می‌آیند، بدون تأیید به گروه می‌روند. دسته‌های منتظر قبلی و پست‌های معوق خودکار منتشر نمی‌شوند. در ساعت سکوت ارسالی نیست.`,
    `${mark("stop")}• توقف انتشار: هیچ ارسالی به گروه نیست (ادامه‌ی ادغام، ادامه‌ی دستی و خودکار همه متوقف‌اند؛ دریافت و ذخیره‌ی اسکرپ ادامه دارد).`,
    "",
    `دسته‌ی منتظر تأیید: ${pending} · دسته‌ی ناقص: ${stalled}`,
  ].join("\n");
}

function panelMarkup(mode, env) {
  const b = (text, data) => ({ text, callback_data: data });
  const autoBtn = autoAllowed(env)
    ? [b(`${mode === "auto" ? "✓ " : ""}ارسال خودکار`, "ss:auto")]
    : [b("ارسال خودکار (پس از پایان آزمایش قابل فعال‌سازی است)", "ss:locked")];
  return {
    inline_keyboard: [
      [b(`${mode === "manual" ? "✓ " : ""}تأیید دستی`, "ss:manual")],
      autoBtn,
      [b(`${mode === "stop" ? "✓ " : ""}توقف انتشار`, "ss:stop")],
      [b("🔄 بروزرسانی", "ss:r")],
    ],
  };
}

// /scrape_settings (فقط مالک، در پیوی)
export async function scrapeSettingsCommand(env, chatId) {
  const mode = await scrapeMode(env);
  return tg(env, "sendMessage", { chat_id: chatId, text: await panelText(env), reply_markup: panelMarkup(mode, env), disable_web_page_preview: true });
}

// دکمه‌های ss:*. هر callback دوباره مالک و پیوی را چک می‌کند (dispatch هم چک می‌کند).
// ss:manual / ss:stop / ss:m (لغو) توکن تأیید خودکار را باطل می‌کنند.
// ss:auto → تأیید دوم با نشانه؛ ss:autoy:<t> و ss:go:auto:<backlog>:<t> فقط با نشانه‌ی زنده و یک‌بار مصرف.
export async function handleScrapeSettingsCallback(env, cq, ctx) {
  const owner = await isOwner(env, cq.from.id);
  const chatId = cq.message.chat.id;
  const parts = String(cq.data).split(":");
  const action = parts[1];
  const ack = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: true });
  if (!owner) return ack("");
  const mode = await scrapeMode(env);
  const btn = (text, data) => ({ text, callback_data: data });
  if (["m", "manual", "stop"].includes(action)) await clearAutoToken(env);
  if (action === "locked" || (action === "auto" && !autoAllowed(env))) return ack(LOCKED_TEXT);

  if (action === "r") {
    // بروزرسانی پنل: همان پیام با وضعیت تازه ویرایش می‌شود (توکن تأیید خودکار دست‌نخورده می‌ماند)
    try {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: await panelText(env), reply_markup: panelMarkup(mode, env), disable_web_page_preview: true });
    } catch (e) {
      // بدون تغییر: تلگرام «not modified» می‌دهد؛ پنل از قبل تازه است
      if (!/message is not modified/.test(String(e))) throw e;
    }
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  if (action === "m") {
    return tg(env, "sendMessage",{ chat_id: chatId, text: await panelText(env), reply_markup: panelMarkup(await scrapeMode(env), env), disable_web_page_preview: true });
  }
  if (action === "manual" || action === "stop") {
    if (mode === "stop" && action === "manual") {
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: "از توقف خارج می‌شی. پست‌های معوق چه شوند؟\n• فقط پست‌های جدید: معوق‌ها کنار گذاشته می‌شن و منتشر نمی‌شن.\n• پیشنهاد معوق‌ها: معوق‌ها برای تأیید تو پیش‌نمایش می‌شن (خودکار منتشر نمی‌شن).",
        reply_markup: { inline_keyboard: [[btn("فقط پست‌های جدید", "ss:go:manual:new")], [btn("پیشنهاد معوق‌ها برای تأیید", "ss:go:manual:sug")], [btn("انصراف", "ss:m")]] },
      }).then(() => ack("انتخاب کن"));
    }
    const r = await changeMode(env, cq.from.id, action);
    return ack(r.text);
  }
  if (action === "auto") {
    const consequences = "ارسال خودکار:\n• پست‌های جدیدی که بعد از فعال‌سازی دیده می‌شن، بدون تأیید به گروه می‌روند.\n• دسته‌های منتظر قبلی و پست‌های معوق خودکار منتشر نمی‌شوند.\n• در ساعت سکوت ارسالی نیست و توقف انتشار همه‌ی ارسال‌ها را متوقف می‌کند.";
    if (mode === "auto") return ack("همین حالت از قبل فعال است.");
    const t = await issueAutoToken(env);
    if (mode === "stop") {
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: `${consequences}\n\nاز توقف خارج می‌شی. معوق‌ها چه شوند؟`,
        reply_markup: { inline_keyboard: [[btn("تأیید: خودکار، فقط پست‌های جدید", `ss:go:auto:new:${t}`)], [btn("تأیید: خودکار، معوق‌ها برای تأیید", `ss:go:auto:sug:${t}`)], [btn("انصراف", "ss:m")]] },
      }).then(() => ack("تأیید دوم لازم است"));
    }
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${consequences}\n\nبرای فعال‌سازی یک بار دیگر تأیید کن.`,
      reply_markup: { inline_keyboard: [[btn("تأیید دوم: فعال‌سازی خودکار", `ss:autoy:${t}`)], [btn("انصراف", "ss:m")]] },
    }).then(() => ack("تأیید دوم لازم است"));
  }
  if (action === "autoy") {
    if (!(await consumeAutoToken(env, parts[2]))) return ack("این تأیید منقضی یا استفاده شده. دوباره از /scrape_settings شروع کن.");
    const r = await changeMode(env, cq.from.id, "auto");
    return ack(r.text);
  }
  if (action === "go") {
    const target = parts[2];
    const backlog = parts[3];
    if (mode !== "stop") return ack("این گزینه الان لازم نیست.");
    if (target === "auto" && !(await consumeAutoToken(env, parts[4]))) return ack("این تأیید منقضی یا استفاده شده. دوباره از /scrape_settings شروع کن.");
    const r = await changeMode(env, cq.from.id, target, backlog);
    return ack(r.text);
  }
  return ack("نامعتبر");
}
