// پنل مالک: حالت ارسال خبرهای اسکرپ (تأیید دستی / ارسال خودکار / توقف انتشار).
// فقط اسکرپ؛ یادآوری رویدادها مستقل است. تغییر فقط برای مالک، در هر callback نهایی بررسی می‌شه.
import { tg } from "./telegram.js";
import { isOwner, audit } from "./admin.js";
import { scrapeMode, setScrapePaused } from "./channels.js";
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

// تغییر حالت. actorId باید مالک باشه (بررسی در همین تابع هم تکرار می‌شه).
// backlog (فقط وقتی از توقف خارج می‌شیم): 'new' = معوق‌ها کنار گذاشته؛ 'sug' = معوق‌ها برای تأیید پیشنهاد.
// تغییر حالت هیچ دسته‌ی sending یا نتیجه‌ی مبهمی را آزاد یا دوباره ارسال نمی‌کند.
export async function changeMode(env, actorId, target, backlog = null) {
  if (!(await isOwner(env, actorId))) return { ok: false, text: "این کار فقط برای مالک است." };
  if (!["manual", "auto", "stop"].includes(target)) return { ok: false, text: "حالت نامعتبر." };
  const from = await scrapeMode(env);
  if (from === target) return { ok: true, text: `همین حالت از قبل فعال است: ${LABEL[target]}.` };
  if (from === "stop" && target !== "stop") {
    if (!["new", "sug"].includes(backlog)) return { ok: false, text: "اول مشخص کن پست‌های معوق چه شوند." };
    if (backlog === "new") await skipBacklog(env);
    await setScrapePaused(env, false);
  }
  if (target === "stop") await setScrapePaused(env, true);
  if (target === "auto") {
    await setSetting(env, "scrape_auto", "1");
    // فقط پست‌های دیده‌شده بعد از این لحظه خودکار می‌رن
    await setSetting(env, "scrape_auto_since", nowS());
  }
  if (target === "manual") await setSetting(env, "scrape_auto", "0");
  await audit(env, actorId, "scrape_mode", `${from}->${target}${backlog ? ` backlog=${backlog}` : ""}`);
  if (from === "stop" && backlog === "sug") await prepareBatch(env).catch(() => {});
  return { ok: true, text: `حالت شد: ${LABEL[target]}.` };
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

function panelMarkup(mode) {
  const b = (text, data) => ({ text, callback_data: data });
  return {
    inline_keyboard: [
      [b(`${mode === "manual" ? "✓ " : ""}تأیید دستی`, "ss:manual")],
      [b(`${mode === "auto" ? "✓ " : ""}ارسال خودکار`, "ss:auto")],
      [b(`${mode === "stop" ? "✓ " : ""}توقف انتشار`, "ss:stop")],
    ],
  };
}

// /scrape_settings (فقط مالک، در پیوی)
export async function scrapeSettingsCommand(env, chatId) {
  const mode = await scrapeMode(env);
  return tg(env, "sendMessage", { chat_id: chatId, text: await panelText(env), reply_markup: panelMarkup(mode), disable_web_page_preview: true });
}

// دکمه‌های ss:*. هر callback دوباره مالک و پیوی را چک می‌کند (dispatch هم چک می‌کند).
// ss:manual / ss:stop / ss:auto(نمایش پیامد) / ss:autoy (تأیید دوم) / ss:go:<target>:<backlog>
export async function handleScrapeSettingsCallback(env, cq, ctx) {
  const owner = await isOwner(env, cq.from.id);
  const chatId = cq.message.chat.id;
  const parts = String(cq.data).split(":");
  const action = parts[1];
  const ack = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: true });
  if (!owner) return ack("");
  const mode = await scrapeMode(env);
  const btn = (text, data) => ({ text, callback_data: data });

  if (action === "m") {
    return tg(env, "sendMessage", { chat_id: chatId, text: await panelText(env), reply_markup: panelMarkup(await scrapeMode(env)), disable_web_page_preview: true });
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
    if (mode === "stop") {
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: `${consequences}\n\nاز توقف خارج می‌شی. معوق‌ها چه شوند؟`,
        reply_markup: { inline_keyboard: [[btn("تأیید: خودکار، فقط پست‌های جدید", "ss:go:auto:new")], [btn("تأیید: خودکار، معوق‌ها برای تأیید", "ss:go:auto:sug")], [btn("انصراف", "ss:m")]] },
      }).then(() => ack("تأیید دوم لازم است"));
    }
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${consequences}\n\nبرای فعال‌سازی یک بار دیگر تأیید کن.`,
      reply_markup: { inline_keyboard: [[btn("تأیید دوم: فعال‌سازی خودکار", "ss:autoy")], [btn("انصراف", "ss:m")]] },
    }).then(() => ack("تأیید دوم لازم است"));
  }
  if (action === "autoy") {
    const r = await changeMode(env, cq.from.id, "auto");
    return ack(r.text);
  }
  if (action === "go") {
    const target = parts[2];
    const backlog = parts[3];
    if (mode !== "stop") return ack("این گزینه الان لازم نیست.");
    const r = await changeMode(env, cq.from.id, target, backlog);
    return ack(r.text);
  }
  return ack("نامعتبر");
}
