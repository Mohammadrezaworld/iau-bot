// اعلام هفته‌ی آینده (زوج/فرد) در گروه: هر جمعه ساعت ۲۳:۳۰ تهران، یک بار برای هر هفته.
// کرون دقیقه‌ای هر دقیقه صدا می‌زنه؛ کلید settings جلوی ارسال تکراری رو می‌گیره.
import { tg } from "./telegram.js";
import { tehranParts } from "./monitor.js";
import { tehranToday, weekIndex, parityOf, rangeText, addDays } from "./calendar.js";
import { getSetting } from "./public.js";

export const ANNOUNCE_KEY = "parity_announced";
const FRIDAY = 5;
const SEND_FROM_MIN = 23 * 60 + 30;

export async function announceParity(env, now = Date.now()) {
  const p = tehranParts(now);
  if (new Date(`${p.date}T00:00:00Z`).getUTCDay() !== FRIDAY) return false;
  if (p.hour * 60 + p.minute < SEND_FROM_MIN) return false;

  // هفته‌ی آینده از شنبه فردا شروع می‌شه
  const startIso = await getSetting(env, "semester_start", "2026-09-12");
  const idx = weekIndex(startIso, addDays(tehranToday(now), 1));
  if (!idx) return false;
  const key = String(idx);
  if ((await getSetting(env, ANNOUNCE_KEY, "")) === key) return false;

  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return false;
  await tg(env, "sendMessage", {
    chat_id: groupId,
    text: `هفته‌ی آینده (${rangeText(startIso, idx)}) ${parityOf(idx)} است.`,
    disable_web_page_preview: true,
  });
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(ANNOUNCE_KEY, key).run();
  return true;
}
