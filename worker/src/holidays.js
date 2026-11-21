// مدیریت تعطیلات رسمی در DM (فقط ادمین کامل). تعطیلات روی انتخاب جدول جمعه‌ی مترو اثر دارن.
import { tg, sendMessage, tryDeleteMessage, answerCallback } from "./telegram.js";
import { audit, getRole } from "./admin.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";
import { faDate } from "./calendar.js";
import { pushUndo } from "./undo.js";

const isFullAdmin = async (env, userId) => ["owner", "full"].includes(await getRole(env, userId));

async function removeHoliday(env, userId, iso) {
  const prev = await env.DB.prepare("SELECT title FROM holidays WHERE date = ?").bind(iso).first();
  if (!prev) return null;
  await pushUndo(env, `حذف تعطیلی ${faDate(iso)}`, "holiday", iso, prev.title);
  await env.DB.prepare("DELETE FROM holidays WHERE date = ?").bind(iso).run();
  await audit(env, userId, "holiday_remove", iso);
  return prev.title;
}

export async function holidayCommand(env, chatId, userId, cmd, arg) {
  const text = normalizeDigits(String(arg || "").trim());

  if (cmd === "/holiday_list") {
    const { results } = await env.DB.prepare("SELECT date, title FROM holidays ORDER BY date LIMIT 60").all();
    if (!results.length) return sendMessage(env, chatId, "تعطیلی ثبت نشده.");
    return sendMessage(env, chatId, results.map((r) => `• ${faDate(r.date)}${r.title ? " — " + r.title : ""}`).join("\n"));
  }

  if (cmd === "/holiday_add") {
    const m = text.match(/^(\S+)\s*(.*)$/);
    const iso = m && parseDateInput(m[1]);
    if (!iso) return sendMessage(env, chatId, "فرمت: /holiday_add ۱۴۰۵/۱۰/۰۲ عنوان (عنوان اختیاریه)");
    const title = (m[2] || "").trim() || "تعطیل رسمی";
    const prev = await env.DB.prepare("SELECT title FROM holidays WHERE date = ?").bind(iso).first();
    await pushUndo(env, `ثبت تعطیلی ${faDate(iso)}`, "holiday", iso, prev ? prev.title : null);
    await env.DB.prepare(
      "INSERT INTO holidays (date, title) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title"
    ).bind(iso, title).run();
    await audit(env, userId, "holiday_add", `${iso} ${title}`);
    return sendMessage(env, chatId, `تعطیلی ثبت شد: ${faDate(iso)} — ${title}`);
  }

  // /holiday_remove
  if (!text) {
    const { results } = await env.DB.prepare("SELECT date, title FROM holidays ORDER BY date DESC LIMIT 30").all();
    if (!results.length) return sendMessage(env, chatId, "تعطیلی برای حذف نیست.");
    const rows = results.map((r) => [{ text: `❌ ${faDate(r.date)}`.slice(0, 60), callback_data: `hol:c:${r.date}` }]);
    rows.push([{ text: "بستن", callback_data: "hol:n" }]);
    return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم تعطیلی حذف بشه؟", reply_markup: { inline_keyboard: rows } });
  }
  const iso = parseDateInput(text.split(/\s+/)[0]);
  if (!iso) return sendMessage(env, chatId, "فرمت: /holiday_remove ۱۴۰۵/۱۰/۰۲");
  const removed = await removeHoliday(env, userId, iso);
  return sendMessage(env, chatId, removed === null ? "این تاریخ در فهرست نیست." : `تعطیلی ${faDate(iso)} حذف شد.`);
}

// دکمه‌ها: hol:c:<iso> (تأیید) · hol:y:<iso> (حذف) · hol:n (لغو)
export async function handleHolidayCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const answer = (text = "") => answerCallback(env, cq, text);

  if (!(await isFullAdmin(env, cq.from.id))) return answer("این کار برای سطح دسترسی شما نیست.");
  if (data === "hol:n") {
    await answer();
    await tryDeleteMessage(env, chatId, cq.message.message_id);
    return;
  }

  if (data.startsWith("hol:c:")) {
    const iso = data.slice(6);
    await answer();
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `تعطیلی ${faDate(iso)} حذف شه؟`,
      reply_markup: { inline_keyboard: [[
        { text: "بله، حذف", callback_data: `hol:y:${iso}` },
        { text: "لغو", callback_data: "hol:n" },
      ]] },
    });
  }

  if (data.startsWith("hol:y:")) {
    await answer();
    const iso = data.slice(6);
    const removed = await removeHoliday(env, cq.from.id, iso);
    return sendMessage(env, chatId, removed === null ? "این تاریخ دیگه نیست." : `تعطیلی ${faDate(iso)} حذف شد.`);
  }

  return answer();
}
