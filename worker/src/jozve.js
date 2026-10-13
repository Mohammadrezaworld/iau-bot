// جزوه‌ها و نمونه‌سوال‌ها (/jozve): ادمین فایل رو مستقیم توی کانال خصوصی می‌فرسته (بدون محدودیت حجم ربات)،
// ربات پست کانال رو ثبت می‌کنه و کاربر در گروه با دکمه‌ها انتخاب می‌کنه؛ فایل با copyMessage بدون نام کانال فرستاده می‌شه.
import { tg, sendMessage, tryDeleteMessage } from "./telegram.js";
import { isAdmin, getRole, audit } from "./admin.js";

const RESULT_TTL = 300;
const MENU_TTL = 60; // منو و دستور کاربر بعد از ۶۰ ثانیه پاک می‌شن
const JOZVE_MENU_KEY = "jozve_menu_msg";
const RATE_WINDOW = 600;
const RATE_MAX = 3;
const MAX_NAME_BYTES = 29; // callback_data حداکثر ۶۴ بایته: «j:ef:» + درس + «|» + استاد
const MAX_FILES_PER_SEND = 10;
const EXAM_WORD = "نمونه سوال";
const nowS = () => Math.floor(Date.now() / 1000);
const bytes = (s) => new TextEncoder().encode(s).length;

// جزوه/کتاب: درس | استاد | عنوان (عنوان اختیاریه)
// نمونه‌سوال: نمونه سوال | درس | استاد | ترم (ترم اختیاریه)
export function parseCaption(caption) {
  const parts = String(caption || "").split("|").map((p) => p.trim());
  const isExam = parts[0] === EXAM_WORD;
  const fmtErr = isExam
    ? "فرمت نمونه‌سوال: نمونه سوال | درس | استاد | ترم (ترم اختیاریه)"
    : "فرمت کپشن: درس | استاد | عنوان (عنوان اختیاریه)";

  let course, professor, title;
  if (isExam) {
    if (parts.length < 3 || parts.length > 4) return { error: fmtErr };
    [, course, professor, title = ""] = parts;
  } else {
    if (parts.length < 2 || parts.length > 3) return { error: fmtErr };
    [course, professor, title = ""] = parts;
  }
  if (course.length < 2 || professor.length < 2) return { error: "نام درس و استاد باید حداقل ۲ حرف باشه." };
  if (bytes(course) > MAX_NAME_BYTES || bytes(professor) > MAX_NAME_BYTES) {
    return { error: `نام درس و استاد هر کدوم حداکثر ${MAX_NAME_BYTES} بایت (تقریباً ۱۴ حرف فارسی) باشه.` };
  }
  return { kind: isExam ? "exam" : "note", course, professor, title };
}

// پست جدید کانال خصوصی
export async function handleJozvePost(env, post) {
  if (String(post.chat.id) !== String(env.JOZVE_CHANNEL)) return;
  const doc = post.document;
  if (!doc) return; // فقط فایل‌های document ثبت می‌شن

  const parsed = parseCaption(post.caption);
  if (parsed.error) {
    return sendMessage(env, post.chat.id, `ثبت نشد. ${parsed.error}`);
  }
  const table = parsed.kind === "exam" ? "exam_files" : "jozve_files";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${table} (course, professor, title, file_name, file_size, channel_msg_id, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(parsed.course, parsed.professor, parsed.title, doc.file_name || "", doc.file_size || 0, post.message_id, nowS()).run();
  const label = parsed.kind === "exam" ? "نمونه‌سوال" : "جزوه";
  return sendMessage(env, post.chat.id, `ثبت شد (${label}): ${parsed.course} — ${parsed.professor}`);
}

async function rememberMsg(env, chatId, msgId, ttl = RESULT_TTL) {
  await env.DB.prepare(
    `INSERT INTO metro_messages (chat_id, message_id, delete_at_utc) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET delete_at_utc = excluded.delete_at_utc`
  ).bind(chatId, msgId, nowS() + ttl).run();
}

// ویرایش منو فقط محتوا رو عوض می‌کنه؛ زمان حذفش تمدید نمی‌شه (منو ۶۰ ثانیه بعد از ساخته‌شدن پاک می‌شه)
async function editTemp(env, chatId, msgId, text, markup) {
  try {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text, reply_markup: markup });
  } catch (err) {
    console.error("jozve_edit", err && err.message ? err.message : "unknown");
  }
}

// وضعیت منوی فعال گروه: شناسه‌ی منو و شناسه‌ی دستور کاربری که منو رو باز کرد
async function getMenuState(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(JOZVE_MENU_KEY).first();
  if (!row || !row.value) return null;
  try {
    const st = JSON.parse(row.value);
    return st && typeof st === "object" ? st : null;
  } catch {
    return null;
  }
}

async function saveMenuState(env, state) {
  if (!state) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(JOZVE_MENU_KEY).run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(JOZVE_MENU_KEY, JSON.stringify(state)).run();
}

const ack = (env, cq, text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });

function grid(buttons, tail = []) {
  const rows = [];
  for (let k = 0; k < buttons.length; k += 2) rows.push(buttons.slice(k, k + 2));
  return { inline_keyboard: [...rows, ...(tail.length ? [tail] : [])] };
}

// دسته‌ها: "note" یا "exam"؛ هر کدوم جدول خودشون رو دارن
const TABLE = { note: "jozve_files", exam: "exam_files" };
const CB = { note: { c: "j:c:", f: "j:f:" }, exam: { c: "j:ec:", f: "j:ef:" } };
const TITLE = { note: "جزوه‌ها", exam: "نمونه‌سوال" };
// درس‌هایی که دسته ندارن، دروس اختصاصی حساب می‌شن (جدول‌ها: عمومی، معارف و پایه جدا ثبت شدن)
const DEFAULT_CATEGORY = "دروس اختصاصی";
const CATEGORY_ORDER = ["دروس عمومی", "معارف", "دروس پایه", "دروس اختصاصی"];
const MAX_CATEGORY_BYTES = 40;

// دسته‌ی هر درس (از جدول course_categories)؛ درسی که دسته نداره زیر «دروس اختصاصی» میاد
async function categoryMap(env) {
  const { results } = await env.DB.prepare("SELECT course, category FROM course_categories").all();
  return new Map(results.map((r) => [r.course, r.category]));
}
async function categoryOf(env, course) {
  return (await categoryMap(env)).get(course) || DEFAULT_CATEGORY;
}

// دسته‌هایی که برای این نوع (جزوه/نمونه‌سوال) درس دارن، به ترتیب مشخص
async function categoriesMarkup(env, kind) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]}`).all();
  const map = await categoryMap(env);
  const cats = new Set(results.map((r) => map.get(r.course) || DEFAULT_CATEGORY));
  const ordered = [...CATEGORY_ORDER.filter((c) => cats.has(c)), ...[...cats].filter((c) => !CATEGORY_ORDER.includes(c))];
  if (!ordered.length) return null;
  const buttons = ordered.map((c) => ({ text: c, callback_data: `jk:${kind === "note" ? "n" : "e"}:${c}` }));
  return grid(buttons, [{ text: "بستن", callback_data: "j:x" }]);
}

// درس‌های یک دسته
async function courseMarkupForCategory(env, kind, cat) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]} ORDER BY course`).all();
  const map = await categoryMap(env);
  const buttons = results
    .map((r) => r.course)
    .filter((c) => (map.get(c) || DEFAULT_CATEGORY) === cat && bytes(c) <= MAX_NAME_BYTES)
    .map((c) => ({ text: c, callback_data: `${CB[kind].c}${c}` }));
  if (!buttons.length) return null;
  return grid(buttons, [{ text: "بازگشت", callback_data: kind === "note" ? "j:n" : "j:e" }, { text: "بستن", callback_data: "j:x" }]);
}

async function courseMarkup(env, kind) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]} ORDER BY course LIMIT 60`).all();
  const buttons = results
    .map((r) => r.course)
    .filter((c) => bytes(c) <= MAX_NAME_BYTES)
    .map((c) => ({ text: c, callback_data: `${CB[kind].c}${c}` }));
  return buttons.length ? grid(buttons, [{ text: "بازگشت", callback_data: "j:b" }, { text: "بستن", callback_data: "j:x" }]) : null;
}

function topMarkup() {
  return grid([
    { text: "جزوه‌ها", callback_data: "j:n" },
    { text: "نمونه‌سوال", callback_data: "j:e" },
  ], [{ text: "بستن", callback_data: "j:x" }]);
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
  // فقط یک منوی فعال در گروه: منوی قبلی و دستورش حذف می‌شن تا منوها کنار هم جمع نشن
  const prev = await getMenuState(env);
  if (prev) {
    if (prev.menu) await tryDeleteMessage(env, chatId, prev.menu);
    if (prev.cmd) await tryDeleteMessage(env, chatId, prev.cmd);
  }
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text: "کدوم رو می‌خوای؟", reply_markup: topMarkup() });
  // منو و دستور کاربر هر دو بعد از ۶۰ ثانیه با هم پاک می‌شن
  await rememberMsg(env, chatId, sent.message_id, MENU_TTL);
  await rememberMsg(env, chatId, msg.message_id, MENU_TTL);
  await saveMenuState(env, { menu: sent.message_id, cmd: msg.message_id });
}

// هر فایل یک کلید ثابت داره؛ شناسه‌ی پیامی که توی گروه ساخته شده رو نگه می‌داریم تا دفعه‌ی بعد دوباره کپی نشه
function fileKey(course, professor, f) {
  return `${course}|${professor}|${(f.file_name || String(f.channel_msg_id)).toLowerCase()}`;
}

// فایل قبلاً فرستاده شده → زیر همون پیام ریپلای می‌شه؛ اگه پیام قبلی پاک شده باشه، دوباره کپی می‌شه
// کپی بدون caption فرستاده می‌شه تا کپشن اصلی کانال حفظ بشه
async function sendFileOnce(env, chatId, key, f) {
  const rec = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`jozve_file:${key}`).first();
  if (rec && rec.value) {
    try {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "این فایل قبلاً ارسال شده ↑",
        reply_to_message_id: Number(rec.value),
        disable_web_page_preview: true,
      });
      return "replied";
    } catch (err) {
      if (!/not found/i.test(err && err.message ? err.message : "")) throw err;
      // پیام قبلی پاک شده: دوباره کپی می‌کنیم
    }
  }
  const copied = await tg(env, "copyMessage", {
    chat_id: chatId,
    from_chat_id: env.JOZVE_CHANNEL,
    message_id: f.channel_msg_id,
  });
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(`jozve_file:${key}`, String(copied.message_id)).run();
  return "copied";
}

// دکمه‌های گروه: j:n / j:e (دسته) · j:c:<درس> / j:ec:<درس> · j:f:<درس>|<استاد> / j:ef:<درس>|<استاد> · j:b · j:x
export async function handleJozveCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (data === "j:x") {
    await tryDeleteMessage(env, chatId, msgId);
    await env.DB.prepare("DELETE FROM metro_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, msgId).run();
    // اگه منوی فعال بسته شد، دستور کاربرش هم پاک می‌شه
    const st = await getMenuState(env);
    if (st && st.menu === msgId) {
      if (st.cmd) await tryDeleteMessage(env, chatId, st.cmd);
      await saveMenuState(env, null);
    }
    return ack(env, cq);
  }

  if (data === "j:b") {
    await editTemp(env, chatId, msgId, "کدوم رو می‌خوای؟", topMarkup());
    return ack(env, cq);
  }

  if (data === "j:n" || data === "j:e") {
    const kind = data === "j:n" ? "note" : "exam";
    const markup = await categoriesMarkup(env, kind);
    if (!markup) return ack(env, cq, "هنوز چیزی ثبت نشده");
    await editTemp(env, chatId, msgId, `${TITLE[kind]} — دسته رو انتخاب کن:`, markup);
    return ack(env, cq);
  }

  // دسته انتخاب شد → درس‌های همون دسته
  if (data.startsWith("jk:")) {
    const kind = data[3] === "n" ? "note" : "exam";
    const cat = data.slice(5);
    const markup = await courseMarkupForCategory(env, kind, cat);
    if (!markup) return ack(env, cq, "درسی توی این دسته نیست");
    await editTemp(env, chatId, msgId, `${TITLE[kind]} — ${cat}\nدرس رو انتخاب کن:`, markup);
    return ack(env, cq);
  }

  // درس انتخاب شد → استادها
  for (const kind of ["note", "exam"]) {
    if (!data.startsWith(CB[kind].c)) continue;
    const course = data.slice(CB[kind].c.length);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT professor FROM ${TABLE[kind]} WHERE course = ? ORDER BY professor LIMIT 60`
    ).bind(course).all();
    const buttons = results
      .map((r) => r.professor)
      .filter((p) => bytes(p) <= MAX_NAME_BYTES)
      .map((p) => ({ text: p, callback_data: `${CB[kind].f}${course}|${p}` }));
    if (!buttons.length) return ack(env, cq, "استادی برای این درس نیست");
    const cat = await categoryOf(env, course);
    await editTemp(env, chatId, msgId, `${TITLE[kind]} — ${course}\nاستاد رو انتخاب کن:`, grid(buttons, [
      { text: "بازگشت", callback_data: `jk:${kind === "note" ? "n" : "e"}:${cat}` },
      { text: "بستن", callback_data: "j:x" },
    ]));
    return ack(env, cq);
  }

  // استاد انتخاب شد → فایل‌ها
  for (const kind of ["note", "exam"]) {
    if (!data.startsWith(CB[kind].f)) continue;
    const rest = data.slice(CB[kind].f.length);
    const sep = rest.indexOf("|");
    if (sep < 0) return ack(env, cq);
    const course = rest.slice(0, sep);
    const professor = rest.slice(sep + 1);
    const { results } = await env.DB.prepare(
      `SELECT channel_msg_id, title, file_name FROM ${TABLE[kind]} WHERE course = ? AND professor = ? ORDER BY id LIMIT ?`
    ).bind(course, professor, MAX_FILES_PER_SEND * 3).all();
    if (!results.length) return ack(env, cq, "فایلی پیدا نشد");

    // سقف درخواست برای کاربر عادی (با شمارش دستور /jozve)
    const uid = cq.from && cq.from.id;
    if (!(await isAdmin(env, uid))) {
      const now = nowS();
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jozve_usage WHERE user_id = ? AND at_utc > ?")
        .bind(uid, now - RATE_WINDOW).first();
      if (r.n >= RATE_MAX) return ack(env, cq, "درخواست زیاد شد؛ چند دقیقه دیگه امتحان کن");
      await env.DB.prepare("INSERT INTO jozve_usage (user_id, at_utc) VALUES (?, ?)").bind(uid, now).run();
    }

    // فایل‌های هم‌نام (درس+استاد+نام) در یک درخواست فقط یک بار
    const seenKeys = new Set();
    for (const f of results.slice(0, MAX_FILES_PER_SEND * 3)) {
      const key = fileKey(course, professor, f);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (seenKeys.size > MAX_FILES_PER_SEND) break;
      await sendFileOnce(env, chatId, key, f);
    }
    return ack(env, cq);
  }

  return ack(env, cq);
}

// /jozve_category در DM: بدون آرگومان فهرست؛ «درس | دسته» برای تعیین دسته‌ی درس
export async function jozveCategoryCommand(env, chatId, userId, arg) {
  const text = String(arg || "").trim();
  if (!text) {
    const { results } = await env.DB.prepare("SELECT course, category FROM course_categories ORDER BY category, course").all();
    const lines = results.map((r) => `• ${r.course} — ${r.category}`);
    lines.push("", `درس‌های بدون دسته زیر «${DEFAULT_CATEGORY}» میان. تعیین دسته: /jozve_category درس | دسته`);
    return sendMessage(env, chatId, lines.join("\n"));
  }
  const [course, category] = text.split("|").map((p) => p.trim());
  if (!course || !category) return sendMessage(env, chatId, "فرمت: /jozve_category درس | دسته");
  if (bytes(course) > MAX_NAME_BYTES) return sendMessage(env, chatId, `نام درس حداکثر ${MAX_NAME_BYTES} بایت.`);
  if (bytes(category) > MAX_CATEGORY_BYTES) return sendMessage(env, chatId, `نام دسته حداکثر ${MAX_CATEGORY_BYTES} بایت.`);
  await env.DB.prepare(
    "INSERT INTO course_categories (course, category) VALUES (?, ?) ON CONFLICT(course) DO UPDATE SET category = excluded.category"
  ).bind(course, category).run();
  await audit(env, userId, "jozve_category", `${course} => ${category}`);
  return sendMessage(env, chatId, `«${course}» توی دسته‌ی «${category}» قرار گرفت.`);
}

// /jozve_list در DM
export async function jozveListText(env) {
  const lines = [];
  for (const kind of ["note", "exam"]) {
    const { results } = await env.DB.prepare(
      `SELECT course, professor, COUNT(*) AS n FROM ${TABLE[kind]} GROUP BY course, professor ORDER BY course, professor`
    ).all();
    for (const r of results) lines.push(`• ${TITLE[kind]} — ${r.course} — ${r.professor}: ${r.n} فایل`);
  }
  return lines.length ? lines.join("\n") : "جزوه یا نمونه‌سوالی ثبت نشده است.";
}

// حذف رکورد (پیام کانال دست‌نخورده می‌مونه). پیشوند e برای نمونه‌سوال: jrm:c:e<id> · jrm:y:e<id> · jrm:n
export async function jozveRemoveList(env, chatId) {
  const notes = (await env.DB.prepare("SELECT id, course, professor, title FROM jozve_files ORDER BY id DESC LIMIT 20").all()).results;
  const exams = (await env.DB.prepare("SELECT id, course, professor, title FROM exam_files ORDER BY id DESC LIMIT 10").all()).results;
  const rows = [
    ...notes.map((r) => ({ r, prefix: "", label: `جزوه: ${r.course} — ${r.professor}` })),
    ...exams.map((r) => ({ r, prefix: "e", label: `نمونه‌سوال: ${r.course} — ${r.professor}${r.title ? " — " + r.title : ""}` })),
  ].map((x) => [{ text: `❌ ${x.label}`.slice(0, 60), callback_data: `jrm:c:${x.prefix}${x.r.id}` }]);
  if (!rows.length) return sendMessage(env, chatId, "فایلی برای حذف نیست.");
  rows.push([{ text: "بستن", callback_data: "jrm:n" }]);
  return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم فایل حذف بشه؟", reply_markup: { inline_keyboard: rows } });
}

export async function handleJozveRemoveCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const answer = (text = "") => ack(env, cq, text);
  const role = await getRole(env, cq.from.id);
  if (!role) return answer();
  if (data === "jrm:n") {
    await tryDeleteMessage(env, chatId, cq.message.message_id);
    return answer();
  }

  const parseRef = (raw) => {
    const isExam = raw.startsWith("e");
    return { table: isExam ? "exam_files" : "jozve_files", id: Number(isExam ? raw.slice(1) : raw), raw };
  };

  if (data.startsWith("jrm:c:")) {
    const ref = parseRef(data.slice(6));
    await answer();
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "این فایل از فهرست حذف شه؟ (پیام کانال می‌مونه)",
      reply_markup: { inline_keyboard: [[
        { text: "بله، حذف", callback_data: `jrm:y:${ref.raw}` },
        { text: "لغو", callback_data: "jrm:n" },
      ]] },
    });
  }

  if (data.startsWith("jrm:y:")) {
    const ref = parseRef(data.slice(6));
    if (!Number.isInteger(ref.id)) return answer();
    const row = await env.DB.prepare(`SELECT id FROM ${ref.table} WHERE id = ?`).bind(ref.id).first();
    if (!row) return answer("این فایل دیگه نیست");
    await env.DB.prepare(`DELETE FROM ${ref.table} WHERE id = ?`).bind(ref.id).run();
    await audit(env, cq.from.id, "jozve_remove", `${ref.table}:${ref.id}`);
    await answer("حذف شد");
    return sendMessage(env, chatId, "فایل از فهرست حذف شد.");
  }
  return answer();
}
