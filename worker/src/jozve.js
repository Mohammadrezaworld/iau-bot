// جزوه‌ها (/jozve): ادمین فایل رو مستقیم توی کانال خصوصی می‌فرسته (بدون محدودیت حجم ربات)،
// ربات پست کانال رو ثبت می‌کنه و کاربر در گروه با دکمه‌ها درس و استاد رو انتخاب می‌کنه؛ فایل با copyMessage بدون نام کانال فرستاده می‌شه.
import { tg, sendMessage, tryDeleteMessage } from "./telegram.js";
import { isAdmin, getRole, audit } from "./admin.js";

const RESULT_TTL = 300;
const RATE_WINDOW = 600;
const RATE_MAX = 3;
const MAX_NAME_BYTES = 29; // callback_data حداکثر ۶۴ بایته: «j:f:» + درس + «|» + استاد
const MAX_FILES_PER_SEND = 10;
const nowS = () => Math.floor(Date.now() / 1000);
const bytes = (s) => new TextEncoder().encode(s).length;

// کپشن: درس | استاد | عنوان (عنوان اختیاریه)
export function parseCaption(caption) {
  const parts = String(caption || "").split("|").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return { error: "فرمت کپشن: درس | استاد | عنوان (عنوان اختیاریه)" };
  const [course, professor, title = ""] = parts;
  if (course.length < 2 || professor.length < 2) return { error: "نام درس و استاد باید حداقل ۲ حرف باشه." };
  if (bytes(course) > MAX_NAME_BYTES || bytes(professor) > MAX_NAME_BYTES) {
    return { error: `نام درس و استاد هر کدوم حداکثر ${MAX_NAME_BYTES} بایت (تقریباً ۱۴ حرف فارسی) باشه.` };
  }
  return { course, professor, title };
}

// پست جدید کانال خصوصی جزوه
export async function handleJozvePost(env, post) {
  if (String(post.chat.id) !== String(env.JOZVE_CHANNEL)) return;
  const doc = post.document;
  if (!doc) return; // فقط فایل‌های document ثبت می‌شن

  const parsed = parseCaption(post.caption);
  if (parsed.error) {
    return sendMessage(env, post.chat.id, `ثبت نشد. ${parsed.error}`);
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jozve_files (course, professor, title, file_name, file_size, channel_msg_id, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(parsed.course, parsed.professor, parsed.title, doc.file_name || "", doc.file_size || 0, post.message_id, nowS()).run();
  return sendMessage(env, post.chat.id, `ثبت شد: ${parsed.course} — ${parsed.professor}`);
}

async function rememberMsg(env, chatId, msgId) {
  await env.DB.prepare(
    `INSERT INTO metro_messages (chat_id, message_id, delete_at_utc) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET delete_at_utc = excluded.delete_at_utc`
  ).bind(chatId, msgId, nowS() + RESULT_TTL).run();
}

async function sendTemp(env, chatId, text, markup) {
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup: markup });
  await rememberMsg(env, chatId, sent.message_id);
}

async function editTemp(env, chatId, msgId, text, markup) {
  try {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text, reply_markup: markup });
  } catch (err) {
    console.error("jozve_edit", err && err.message ? err.message : "unknown");
  }
  await rememberMsg(env, chatId, msgId);
}

const ack = (env, cq, text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });

function grid(buttons, tail = []) {
  const rows = [];
  for (let k = 0; k < buttons.length; k += 2) rows.push(buttons.slice(k, k + 2));
  return { inline_keyboard: [...rows, ...(tail.length ? [tail] : [])] };
}

async function courseMarkup(env) {
  const { results } = await env.DB.prepare("SELECT DISTINCT course FROM jozve_files ORDER BY course LIMIT 60").all();
  const buttons = results
    .map((r) => r.course)
    .filter((c) => bytes(c) <= MAX_NAME_BYTES)
    .map((c) => ({ text: c, callback_data: `j:c:${c}` }));
  return buttons.length ? grid(buttons, [{ text: "بستن", callback_data: "j:x" }]) : null;
}

// /jozve در گروه (ربات دستور رو بعد از پاسخ پاک می‌کنه)
export async function handleJozveCommand(env, msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  if (!(await isAdmin(env, uid))) {
    const now = nowS();
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jozve_usage WHERE user_id = ? AND at_utc > ?")
      .bind(uid, now - RATE_WINDOW).first();
    if (r.n >= RATE_MAX) return tryDeleteMessage(env, chatId, msg.message_id);
    await env.DB.prepare("INSERT INTO jozve_usage (user_id, at_utc) VALUES (?, ?)").bind(uid, now).run();
    await env.DB.prepare("DELETE FROM jozve_usage WHERE at_utc < ?").bind(now - 3600).run();
  }
  const markup = await courseMarkup(env);
  if (!markup) await sendTemp(env, chatId, "هنوز جزوه‌ای ثبت نشده است.");
  else await sendTemp(env, chatId, "جزوه‌ها — درس رو انتخاب کن:", markup);
  await tryDeleteMessage(env, chatId, msg.message_id);
}

// دکمه‌های گروه: j:c:<درس> · j:f:<درس>|<استاد> · j:x
export async function handleJozveCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (data === "j:x") {
    await tryDeleteMessage(env, chatId, msgId);
    await env.DB.prepare("DELETE FROM metro_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, msgId).run();
    return ack(env, cq);
  }

  if (data.startsWith("j:c:")) {
    const course = data.slice(4);
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT professor FROM jozve_files WHERE course = ? ORDER BY professor LIMIT 60"
    ).bind(course).all();
    const buttons = results
      .map((r) => r.professor)
      .filter((p) => bytes(p) <= MAX_NAME_BYTES)
      .map((p) => ({ text: p, callback_data: `j:f:${course}|${p}` }));
    if (!buttons.length) return ack(env, cq, "استادی برای این درس نیست");
    await editTemp(env, chatId, msgId, `درس: ${course}\nاستاد رو انتخاب کن:`, grid(buttons, [
      { text: "بازگشت", callback_data: "j:b" },
      { text: "بستن", callback_data: "j:x" },
    ]));
    return ack(env, cq);
  }

  if (data === "j:b") {
    const markup = await courseMarkup(env);
    if (markup) await editTemp(env, chatId, msgId, "جزوه‌ها — درس رو انتخاب کن:", markup);
    return ack(env, cq);
  }

  if (data.startsWith("j:f:")) {
    const sep = data.indexOf("|");
    if (sep < 0) return ack(env, cq);
    const course = data.slice(4, sep);
    const professor = data.slice(sep + 1);
    const { results } = await env.DB.prepare(
      "SELECT channel_msg_id, title, file_name FROM jozve_files WHERE course = ? AND professor = ? ORDER BY id LIMIT ?"
    ).bind(course, professor, MAX_FILES_PER_SEND).all();
    if (!results.length) return ack(env, cq, "فایلی پیدا نشد");
    for (const f of results) {
      // copyMessage: بدون «فوروارد از» و بدون محدودیت حجم، چون تلگرام خودش کپی می‌کنه
      await tg(env, "copyMessage", {
        chat_id: chatId,
        from_chat_id: env.JOZVE_CHANNEL,
        message_id: f.channel_msg_id,
        caption: f.title || f.file_name || "",
      });
    }
    return ack(env, cq);
  }

  return ack(env, cq);
}

// /jozve_list در DM
export async function jozveListText(env) {
  const { results } = await env.DB.prepare(
    "SELECT course, professor, COUNT(*) AS n FROM jozve_files GROUP BY course, professor ORDER BY course, professor"
  ).all();
  if (!results.length) return "جزوه‌ای ثبت نشده است.";
  return results.map((r) => `• ${r.course} — ${r.professor}: ${r.n} فایل`).join("\n");
}

// حذف رکورد (پیام کانال دست‌نخورده می‌مونه). دکمه‌ها: jrm:c:<id> · jrm:y:<id> · jrm:n
export async function jozveRemoveList(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT id, course, professor, title, file_name FROM jozve_files ORDER BY id DESC LIMIT 30"
  ).all();
  if (!results.length) return sendMessage(env, chatId, "فایلی برای حذف نیست.");
  const rows = results.map((r) => [{
    text: `❌ ${r.course} — ${r.professor}${r.title ? " — " + r.title : ""}`.slice(0, 60),
    callback_data: `jrm:c:${r.id}`,
  }]);
  return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم فایل حذف بشه؟", reply_markup: { inline_keyboard: rows } });
}

export async function handleJozveRemoveCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const answer = (text = "") => ack(env, cq, text);
  const role = await getRole(env, cq.from.id);
  if (!role) return answer();
  if (data === "jrm:n") return answer("لغو شد");

  if (data.startsWith("jrm:c:")) {
    const id = Number(data.slice(6));
    await answer();
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "این فایل از فهرست حذف شه؟ (پیام کانال می‌مونه)",
      reply_markup: { inline_keyboard: [[
        { text: "بله، حذف", callback_data: `jrm:y:${id}` },
        { text: "لغو", callback_data: "jrm:n" },
      ]] },
    });
  }

  if (data.startsWith("jrm:y:")) {
    const id = Number(data.slice(6));
    const row = await env.DB.prepare("SELECT id FROM jozve_files WHERE id = ?").bind(id).first();
    if (!row) return answer("این فایل دیگه نیست");
    await env.DB.prepare("DELETE FROM jozve_files WHERE id = ?").bind(id).run();
    await audit(env, cq.from.id, "jozve_remove", String(id));
    await answer("حذف شد");
    return sendMessage(env, chatId, "فایل از فهرست حذف شد.");
  }
  return answer();
}
