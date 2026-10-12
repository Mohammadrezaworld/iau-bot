// /scrape: اجرای دستی اسکرپ بله و تلگرام از داخل پیوی (فقط ادمین کامل).
// ربات با توکن گیت‌هاب (secret به اسم GH_DISPATCH_TOKEN) کار workflow_dispatch رو فرستاد می‌کنه.
import { sendMessage } from "./telegram.js";
import { audit } from "./admin.js";

const WORKFLOWS = ["scrape-bale.yml", "scrape-telegram.yml"];
const COOLDOWN = 20 * 60; // ثانیه: حداقل فاصله بین دو اجرای دستی
const nowS = () => Math.floor(Date.now() / 1000);

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function scrapeCommand(env, chatId, userId) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) {
    return sendMessage(env, chatId, "توکن اجرای اسکرپ هنوز تنظیم نشده است.");
  }
  const last = Number((await getSetting(env, "last_manual_scrape")) || 0);
  const left = COOLDOWN - (nowS() - last);
  if (left > 0) {
    return sendMessage(env, chatId, `اسکرپ دستی همین الان اجرا شده. ${Math.ceil(left / 60)} دقیقه‌ی دیگه دوباره امتحان کن.`);
  }

  const failed = [];
  for (const wf of WORKFLOWS) {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "iaut-bot",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status !== 204) failed.push(`${wf} (${res.status})`);
  }

  if (failed.length === WORKFLOWS.length) {
    return sendMessage(env, chatId, `اجرای اسکرپ ناموفق بود: ${failed.join("، ")}. توکن و دسترسی رو بررسی کن.`);
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('last_manual_scrape', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(nowS())).run();
  await audit(env, userId, "scrape_manual", failed.length ? `partial: ${failed.join(",")}` : "all");
  const note = failed.length ? `\nبعضی‌ها ارسال نشدن: ${failed.join("، ")}` : "";
  return sendMessage(env, chatId, `اسکرپ دستی برای بله و تلگرام فرستاده شد. نتیجه‌ش رو بعد از چند دقیقه با /status ببین.${note}`);
}
