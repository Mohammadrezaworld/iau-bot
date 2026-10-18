// یادآوری رویدادها به گروه: یک روز قبل (۲۰:۳۰ UTC = ۲۰:۰۰ تهران) و روز رویداد (۰۴:۳۰ UTC = ۰۸:۰۰ تهران).
import { tg } from "./telegram.js";
import { tehranToday, addDays, faDate } from "./calendar.js";
import { getSetting } from "./public.js";
import { inTehranQuietHours } from "./channels.js";

export async function sendReminders(env, cron) {
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return;
  // ساعت سکوت گروه: ارسال نمی‌شه و در reminder_log هم ثبت نمی‌شه، تا اجرای بعدی بیرون از سکوت بفرستدش
  if (await inTehranQuietHours(env)) return;

  const today = tehranToday();
  const isEvening = cron === "30 16 * * *";
  const kind = isEvening ? "pre" : "day";
  const targetDate = isEvening ? addDays(today, 1) : today;

  const { results } = await env.DB.prepare(
    `SELECT e.* FROM events e
     WHERE e.archived = 0 AND e.start_date = ?
       AND NOT EXISTS (SELECT 1 FROM reminder_log r WHERE r.event_id = e.id AND r.kind = ?)`
  ).bind(targetDate, kind).all();

  for (const e of results) {
    const text = isEvening
      ? `📢 یادآوری: فردا ${faDate(e.start_date)} — ${e.title}`
      : `📢 امروز ${faDate(e.start_date)} — ${e.title}`;
    await tg(env, "sendMessage", { chat_id: groupId, text, disable_web_page_preview: true });
    await env.DB.prepare("INSERT OR IGNORE INTO reminder_log (event_id, kind) VALUES (?, ?)").bind(e.id, kind).run();
  }
}
