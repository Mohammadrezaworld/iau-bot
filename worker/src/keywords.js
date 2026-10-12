// مدیریت کلمات کلیدی اعلان کانال‌ها (فقط ادمین کامل). فهرست در settings با کلید keywords به‌صورت JSON ذخیره می‌شه.
import { tg, sendMessage } from "./telegram.js";
import { audit, getRole } from "./admin.js";
import { keywordsList, normalizeForMatch } from "./channels.js";

const MAX_LEN = 30;
// callback_data حداکثر ۶۴ بایته؛ پیشوند «kw:y:» ۵ بایته، پس کلمه تا ۵۰ بایت (UTF-8)
const MAX_BYTES = 50;
const bytes = (s) => new TextEncoder().encode(s).length;

async function save(env, list) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('keywords', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(JSON.stringify(list)).run();
}

const isFullAdmin = async (env, userId) => ["owner", "full"].includes(await getRole(env, userId));

// دستورهای /keyword_* در DM
export async function keywordCommand(env, chatId, userId, cmd, arg) {
  const list = await keywordsList(env);

  if (cmd === "/keyword_list") {
    const text = list.length ? list.map((k, i) => `${i + 1}. ${k}`).join("\n") : "کلمه‌ای ثبت نشده.";
    return sendMessage(env, chatId, text);
  }

  if (cmd === "/keyword_add") {
    const w = String(arg || "").replace(/\s+/g, " ").trim();
    if (!w) return sendMessage(env, chatId, "فرمت: /keyword_add متن کلمه");
    if (w.length > MAX_LEN || bytes(w) > MAX_BYTES) return sendMessage(env, chatId, `حداکثر ${MAX_LEN} حرف`);
    const nk = normalizeForMatch(w);
    if (list.some((k) => normalizeForMatch(k) === nk)) return sendMessage(env, chatId, "این کلمه از قبل هست.");
    await save(env, [...list, w]);
    await audit(env, userId, "keyword_add", w);
    return sendMessage(env, chatId, `کلمه «${w}» اضافه شد. از پست‌های بعدی اعمال می‌شه.`);
  }

  // /keyword_remove
  const w = String(arg || "").replace(/\s+/g, " ").trim();
  if (!w) {
    if (!list.length) return sendMessage(env, chatId, "کلمه‌ای برای حذف نیست.");
    const rows = list
      .filter((k) => bytes(k) <= MAX_BYTES)
      .map((k) => [{ text: `❌ ${k}`.slice(0, 60), callback_data: `kw:c:${k}` }]);
    return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم حذف بشه؟", reply_markup: { inline_keyboard: rows } });
  }
  const target = list.find((k) => normalizeForMatch(k) === normalizeForMatch(w));
  if (!target) return sendMessage(env, chatId, "این کلمه پیدا نشد. /keyword_list رو بزن.");
  await save(env, list.filter((k) => k !== target));
  await audit(env, userId, "keyword_remove", target);
  return sendMessage(env, chatId, `کلمه «${target}» حذف شد.`);
}

// دکمه‌های لیست حذف: kw:c:<کلمه> (تأیید) · kw:y:<کلمه> (حذف) · kw:n (لغو)
export async function handleKeywordCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const answer = (text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });

  if (!(await isFullAdmin(env, cq.from.id))) return answer("این کار برای سطح دسترسی شما نیست.");

  if (data === "kw:n") return answer("لغو شد");

  if (data.startsWith("kw:c:")) {
    const w = data.slice(5);
    await answer();
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `کلمه‌ی «${w}» حذف شه؟`,
      reply_markup: { inline_keyboard: [[
        { text: "بله، حذف", callback_data: `kw:y:${w}` },
        { text: "لغو", callback_data: "kw:n" },
      ]] },
    });
  }

  if (data.startsWith("kw:y:")) {
    const w = data.slice(5);
    const list = await keywordsList(env);
    const target = list.find((k) => k === w);
    if (!target) return answer("این کلمه دیگه نیست");
    await save(env, list.filter((k) => k !== target));
    await audit(env, cq.from.id, "keyword_remove", target);
    await answer("حذف شد");
    return sendMessage(env, chatId, `کلمه «${target}» حذف شد.`);
  }

  return answer();
}
