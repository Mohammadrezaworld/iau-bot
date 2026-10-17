// جزوه‌ها و نمونه‌سوال‌ها (/jozve): ادمین فایل رو مستقیم توی کانال خصوصی می‌فرسته (بدون محدودیت حجم ربات)،
// ربات پست کانال رو ثبت می‌کنه و کاربر در گروه با دکمه‌ها انتخاب می‌کنه؛ فایل با copyMessage بدون نام کانال فرستاده می‌شه.
import { tg, sendMessage, tryDeleteMessage } from "./telegram.js";
import { isAdmin, getRole, audit } from "./admin.js";
import { recordEvent } from "./monitor.js";
import { claimExternal, finishExternal, LeaseLostError, AmbiguousError } from "./effects.js";

const RESULT_TTL = 300;
const LINKS_TTL = 600; // پیام لیست لینک‌های فایل‌های قبلی بعد از ۱۰ دقیقه پاک می‌شه
const MENU_TTL = 60; // منو و دستور کاربر بعد از ۶۰ ثانیه بی‌فعالیتی پاک می‌شن (هر کلیک روی منو این مهلت رو از نو می‌ده)
const LIMIT_TTL = 15; // پیام سقف درخواست بعد از ۱۵ ثانیه پاک می‌شه
const JOZVE_MENU_KEY = "jozve_menu_msg";
const RATE_WINDOW = 600;
const RATE_MAX = 2; // سقف مشترک: باز کردن /jozve و گرفتن فایل با هم، برای کاربر عادی
const LIMIT_TEXT = "لطفاً کمی صبر کن؛ هر نفر حداکثر ۲ درخواست توی ۱۰ دقیقه می‌تونه بده.";
const MAX_NAME_BYTES = 29; // callback_data حداکثر ۶۴ بایته: «j:ef:» + درس + «|» + استاد
const MAX_FILES_PER_SEND = 10;
const EXAM_WORD = "نمونه سوال";
const CONFIRM_TTL = 120; // پیام تأیید ثبت فایل بعد از ۲ دقیقه پاک می‌شه (کرون هر دقیقه، همون cleanupMetroMessages)
const NEW_KIND_WORD = new Map([["کتاب", "book"], ["دوره", "course"], ["چنل", "channel"]]);
const NEW_KIND_FORMAT = {
  book: "کتاب | نام کتاب | نویسنده",
  course: "دوره | نام دوره | مدرس",
  channel: "چنل | نام چنل | موضوع",
};
const LABEL = { note: "جزوه", exam: "نمونه‌سوال", book: "کتاب", course: "دوره", channel: "چنل مفید" };
const nowS = () => Math.floor(Date.now() / 1000);
const bytes = (s) => new TextEncoder().encode(s).length;

// جزوه/کتاب: درس | استاد | عنوان (عنوان اختیاریه)
// نمونه‌سوال: نمونه سوال | درس | استاد | ترم (ترم اختیاریه)
export function parseCaption(caption) {
  const parts = String(caption || "").split("|").map((p) => p.trim());
  const newKind = NEW_KIND_WORD.get(parts[0]);
  if (newKind) {
    // کتاب | نام کتاب | نویسنده · دوره | نام دوره | مدرس · چنل | نام چنل | موضوع
    if (parts.length !== 3) return { error: `فرمت ${LABEL[newKind]}: ${NEW_KIND_FORMAT[newKind]}` };
    const [, name, who] = parts;
    if (name.length < 2 || who.length < 2) return { error: "نام و بخش دوم باید حداقل ۲ حرف باشه." };
    if (bytes(name) > MAX_NAME_BYTES || bytes(who) > MAX_NAME_BYTES) {
      return { error: `هر بخش حداکثر ${MAX_NAME_BYTES} بایت (تقریباً ۱۴ حرف فارسی) باشه.` };
    }
    return { kind: newKind, course: name, professor: who, title: "" };
  }
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

// فایل (document) یا عکس (photo) کانال؛ بقیه‌ی نوع‌ها (ویدیو، استیکر و…) نادیده گرفته می‌شن
function mediaOf(post) {
  if (post.document) return { file_name: post.document.file_name || "", file_size: post.document.file_size || 0 };
  if (Array.isArray(post.photo) && post.photo.length) {
    const largest = post.photo[post.photo.length - 1]; // آخرین سایز = بزرگ‌ترین
    return { file_name: "", file_size: largest.file_size || 0 };
  }
  return null;
}

// پست جدید کانال خصوصی
export async function handleJozvePost(env, post) {
  if (String(post.chat.id) !== String(env.JOZVE_CHANNEL)) return;
  const media = mediaOf(post);
  if (!media) return;

  // آلبوم: کپشن فقط روی فایل اول است؛ بقیه با مشخصات همون آلبوم (album_groups) ثبت می‌شن
  const group = post.media_group_id ? String(post.media_group_id) : "";
  let parsed;
  if (!post.caption && group) {
    const rec = await env.DB.prepare("SELECT kind, course, professor, title FROM album_groups WHERE media_group_id = ?").bind(group).first();
    parsed = rec ? rec : { error: "این فایل آلبوم کپشن نداره؛ کپشن باید روی اولین فایل آلبوم باشه." };
  } else {
    parsed = parseCaption(post.caption);
  }
  if (parsed.error) {
    return sendMessage(env, post.chat.id, `ثبت نشد. ${parsed.error}`);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${TABLE[parsed.kind]} (course, professor, title, file_name, file_size, channel_msg_id, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(parsed.course, parsed.professor, parsed.title || "", media.file_name, media.file_size, post.message_id, nowS()).run();
  if (group && post.caption) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO album_groups (media_group_id, kind, course, professor, title, created_utc) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(group, parsed.kind, parsed.course, parsed.professor, parsed.title || "", nowS()).run();
  }
  // اعضای آلبوم بدون کپشن بی‌صدا ثبت می‌شن؛ فقط یک تأیید برای هر آلبوم فرستاده می‌شه
  if (!post.caption) return;
  const text = `ثبت شد (${LABEL[parsed.kind]}${group ? "، آلبوم" : ""}): ${parsed.course} — ${parsed.professor}`;
  const sent = await tg(env, "sendMessage", { chat_id: post.chat.id, text, disable_web_page_preview: true });
  await rememberMsg(env, post.chat.id, sent.message_id, CONFIRM_TTL);
}

async function rememberMsg(env, chatId, msgId, ttl = RESULT_TTL) {
  await env.DB.prepare(
    `INSERT INTO metro_messages (chat_id, message_id, delete_at_utc) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET delete_at_utc = excluded.delete_at_utc`
  ).bind(chatId, msgId, nowS() + ttl).run();
}

// ویرایش منو فقط محتوا رو عوض می‌کنه؛ زمان حذفش رو touchMenu جدا تمدید می‌کنه
async function editTemp(env, chatId, msgId, text, markup) {
  try {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text, reply_markup: markup });
  } catch (err) {
    console.error("jozve_edit", err && err.message ? err.message : "unknown");
  }
}

// هر کلیک روی منوی فعال، ۶۰ ثانیه‌ی دیگه بهش می‌ده (منو و دستور کاربر با هم)
async function touchMenu(env, chatId, msgId) {
  const st = await getMenuState(env);
  if (!st || st.menu !== msgId) return;
  await rememberMsg(env, chatId, st.menu, MENU_TTL);
  if (st.cmd) await rememberMsg(env, chatId, st.cmd, MENU_TTL);
}

// بستن منو: خود منو و دستور کاربرش (اگه منوی فعاله) پاک می‌شن
async function closeMenu(env, chatId, msgId) {
  await tryDeleteMessage(env, chatId, msgId);
  await env.DB.prepare("DELETE FROM metro_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, msgId).run();
  const st = await getMenuState(env);
  if (st && st.menu === msgId) {
    if (st.cmd) {
      await tryDeleteMessage(env, chatId, st.cmd);
      await env.DB.prepare("DELETE FROM metro_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, st.cmd).run();
    }
    await saveMenuState(env, null);
  }
}

// پیام کوتاه سقف: قابل‌دیدن، و بعد از ۱۵ ثانیه خودش پاک می‌شه
async function notifyLimit(env, chatId) {
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text: LIMIT_TEXT });
  await rememberMsg(env, chatId, sent.message_id, LIMIT_TTL);
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
const TABLE = { note: "jozve_files", exam: "exam_files", book: "book_files", course: "course_files", channel: "channel_files" };
const CB = { note: { c: "j:c:", f: "j:f:" }, exam: { c: "j:ec:", f: "j:ef:" } };
const TITLE = { note: "جزوه‌ها", exam: "نمونه‌سوال", book: "کتاب‌ها", course: "دوره‌ها", channel: "چنل‌های مفید" };
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

// /jozve در گروه: منوی گروه حذف شده؛ دستور پاک می‌شه و کاربر به پیوی ربات راهنمایی می‌شه.
// (تا وقتی منوی شخصی پیوی آماده نشده، این تغییر merge نمی‌شه)
const GROUP_GUIDE = "این خدمت از این به بعد از پیوی ربات گرفته می‌شه. به ربات در پیوی پیام بده.";
// دستورهایی که از گروه به پیوی منتقل شدن: یک راهنمای مشترک برای گروه.
// اگه راهنما هنوز فعاله، همون پیام می‌مونه و زمانش تمدید میشه؛ دستور کاربر هم پاک می‌شه.
const GROUP_GUIDE_KEY = "group_guide_msg";
export async function groupMovedGuide(env, chatId, msgId) {
  await tryDeleteMessage(env, chatId, msgId);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(GROUP_GUIDE_KEY).first();
  let st = null;
  try { st = row && row.value ? JSON.parse(row.value) : null; } catch { st = null; }
  const now = nowS();
  if (st && st.chat === chatId && now < st.until) {
    await rememberMsg(env, chatId, st.msg, MENU_TTL);
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(GROUP_GUIDE_KEY, JSON.stringify({ ...st, until: now + MENU_TTL })).run();
    return;
  }
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text: GROUP_GUIDE });
  await rememberMsg(env, chatId, sent.message_id, MENU_TTL);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(GROUP_GUIDE_KEY, JSON.stringify({ chat: chatId, msg: sent.message_id, until: now + MENU_TTL })).run();
}

export async function handleJozveCommand(env, msg) {
  return groupMovedGuide(env, msg.chat.id, msg.message_id);
}

// هر فایل یک کلید ثابت داره؛ شناسه‌ی پیامی که توی گروه ساخته شده رو نگه می‌داریم تا دفعه‌ی بعد دوباره کپی نشه
function fileKey(course, professor, f) {
  return `${course}|${professor}|${(f.file_name || String(f.channel_msg_id)).toLowerCase()}`;
}

async function fileRecord(env, key) {
  const rec = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`jozve_file:${key}`).first();
  return rec && rec.value ? Number(rec.value) : null;
}

async function saveFileRecord(env, key, msgId) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(`jozve_file:${key}`, String(msgId)).run();
}

// لینک پیام توی گروه سوپرگروه (فقط برای اعضای گروه باز میشه)
function groupMsgLink(chatId, msgId) {
  const s = String(chatId);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${msgId}`;
}

// دکمه‌های گروه: j:n / j:e (دسته) · j:c:<درس> / j:ec:<درس> · j:f:<درس>|<استاد> / j:ef:<درس>|<استاد> · j:b · j:x
export async function handleJozveCallback(env, cq, ctx = null) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (data === "j:x") {
    await closeMenu(env, chatId, msgId);
    return ack(env, cq);
  }

  // هر کلیک روی منو (غیر از بستن) مهلت منو رو از نو شروع می‌کنه
  await touchMenu(env, chatId, msgId);

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

    // سقف مشترک برای کاربر عادی (با شمارش دستور /jozve)
    const uid = cq.from && cq.from.id;
    if (!(await isAdmin(env, uid))) {
      const now = nowS();
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jozve_usage WHERE user_id = ? AND at_utc > ?")
        .bind(uid, now - RATE_WINDOW).first();
      if (r.n >= RATE_MAX) {
        await notifyLimit(env, chatId);
        return ack(env, cq);
      }
      await env.DB.prepare("INSERT INTO jozve_usage (user_id, at_utc) VALUES (?, ?)").bind(uid, now).run();
    }

    // فایل‌های هم‌نام (درس+استاد+نام) در یک درخواست فقط یک بار
    const seenKeys = new Set();
    const oldFiles = [];
    let copies = 0;
    let copyFailed = 0;
    let ambiguous = 0;
    for (const f of results.slice(0, MAX_FILES_PER_SEND * 3)) {
      const key = fileKey(course, professor, f);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (seenKeys.size > MAX_FILES_PER_SEND) break;
      const prevId = await fileRecord(env, key);
      if (prevId) {
        oldFiles.push({ name: f.title || f.file_name || "فایل", id: prevId });
        continue;
      }
      // ارسال فقط بعد از claim با lease همین اجرا (effects): تأیید هم‌زمان یا اجرای قدیمی، دو کپی نمی‌سازه
      const opKey = `publish:${chatId}:${key}`;
      const claim = await claimExternal(env, ctx, opKey, "publish");
      if (claim.status === "lease_lost") throw new LeaseLostError();
      if (claim.status === "done") {
        // قبلاً فرستاده شده: اگه شناسه‌ی پیام معلومه، لینکش داده می‌شه (تأیید دستی مالک شناسه نداره)
        if (claim.msgId) oldFiles.push({ name: f.title || f.file_name || "فایل", id: claim.msgId });
        continue;
      }
      if (claim.status === "busy") { copyFailed += 1; continue; }
      if (claim.status === "ambiguous") { ambiguous += 1; continue; }
      // خطای یک فایل، بقیه‌ی فایل‌ها رو متوقف نمی‌کنه
      try {
        // copyMessage بدون caption: کپشن اصلی کانال حفظ می‌شه
        const copied = await tg(env, "copyMessage", {
          chat_id: chatId,
          from_chat_id: env.JOZVE_CHANNEL,
          message_id: f.channel_msg_id,
        });
        await finishExternal(env, ctx, opKey, { ok: true, msgId: copied.message_id, result: `copy ${key}` });
        await saveFileRecord(env, key, copied.message_id);
        copies += 1;
      } catch (err) {
        copyFailed += 1;
        const msgText = err && err.message ? err.message : "unknown";
        if (err && err.refused) {
          // تلگرام صریحاً رد کرده؛ اثری نبوده و تلاش بعدی مجازه
          await finishExternal(env, ctx, opKey, { ok: false, error: msgText });
        } else {
          // نتیجه نامشخصه (شبکه/پاسخ ناخوانا): intent می‌مونه و تا تصمیم مالک دوباره ارسال نمی‌شه
          ambiguous += 1;
        }
        await recordEvent(env, "jozve", "", "error", `copy ${key}: ${msgText}`);
      }
    }

    // فایل‌هایی که قبلاً فرستاده شدن: یک پیام با لینک همه‌شون (بعد از ۱۰ دقیقه پاک می‌شه)
    const links = oldFiles.map((o) => ({ name: o.name, url: groupMsgLink(chatId, o.id) })).filter((o) => o.url);
    if (links.length) {
      const lines = ["این فایل‌ها قبلاً ارسال شدن (روی هر کدوم بزنی می‌ره):", ...links.map((o) => `• ${o.name}\n${o.url}`)];
      const sent = await tg(env, "sendMessage", { chat_id: chatId, text: lines.join("\n"), disable_web_page_preview: true });
      await rememberMsg(env, chatId, sent.message_id, LINKS_TTL);
    }
    if (ambiguous) {
      // نتیجه‌ی بعضی فایل‌ها نامشخصه: تلاش خودکار نمی‌کنیم؛ مالک با /review تصمیم می‌گیره
      await ack(env, cq, "بعضی فایل‌ها نیاز به بررسی دارن؛ مالک خبر می‌گیره");
      throw new AmbiguousError(`publish:${chatId}:${msgId}`);
    }
    if (!copies && !links.length) {
      return ack(env, cq, copyFailed ? "ارسال نشد؛ دوباره امتحان کن" : "فایلی پیدا نشد");
    }
    // فایل فرستاده شد: منو و دستور کاربر دیگه لازم نیستن
    await closeMenu(env, chatId, msgId);
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

// ───── منوی شخصی پیوی (کاربر عادی) ─────
// فقط دکمه‌ی لینک پست کانال عمومی؛ ربات فایل جزوه رو در پیوی نمی‌فرسته.
// هر کاربر یک منوی فعال داره؛ جابه‌جایی با ویرایش همان پیام. دسترسی فقط برای اعضای گروه اصلی.
const DM_TTL = 120; // هر کلیک، ۱۲۰ ثانیه‌ی دیگه می‌ده
const DM_MAX_LIFE = 240; // سقف عمر منو از لحظه‌ی ساخت
export const DM_NOT_MEMBER = "برای استفاده از خدمات ربات باید عضو گروه اصلی باشی. بعد از عضویت دوباره /start بزن.";
const DM_EXPIRED = "این منو منقضی شده. دوباره /jozve بزن.";
const DM_NOT_OWNER = "این منو مال تو نیست!";
const DM_LINK_LIMIT = 40;
export const DM_MENU_PROMPT = "یکی از گزینه‌ها رو انتخاب کن:";
// کد نوع در callback: n = جزوه، e = نمونه‌سوال
// n جزوه · e نمونه‌سوال · b کتاب · u دوره · h چنل مفید
const LETTER_KIND = { n: "note", e: "exam", b: "book", u: "course", h: "channel" };
const KIND_LETTER = { note: "n", exam: "e", book: "b", course: "u", channel: "h" };
const kindOfLetter = (ch) => LETTER_KIND[ch] || "note";
const letterOf = (kind) => KIND_LETTER[kind];

// دکمه‌ها: d:m منوی اصلی · d:n|d:e دسته‌ها · d:c<K><دسته> درس‌ها · d:o<K><درس> استادها · d:f<K><درس>|<استاد> فایل‌ها · d:x بستن
// K = n (جزوه) یا e (نمونه‌سوال). نام درس و استاد حداکثر ۲۹ بایت، پس callback_data از ۶۴ بایت رد نمی‌شه.

// دکمه‌ی عضویت گروه با درخواست عضویت (creates_join_request). لینک یک بار ساخته و کش می‌شه.
export async function groupJoinMarkup(env) {
  try {
    // لینک ثابت گروه (درخواست عضویت، تأیید دستی ادمین‌ها) از wrangler.toml؛ اگه نبود، لینک ساخته و کش می‌شه
    let link = env.GROUP_JOIN_LINK || "";
    if (!link) {
      const cached = await env.DB.prepare("SELECT value FROM settings WHERE key = 'group_join_link'").first();
      link = cached && cached.value;
    }
    if (!link) {
      const g = await env.DB.prepare("SELECT value FROM settings WHERE key = 'group_id'").first();
      if (!g || !g.value) return undefined;
      const r = await tg(env, "createChatInviteLink", { chat_id: g.value, creates_join_request: true, name: "dm-join" });
      link = r && r.invite_link;
      if (!link) return undefined;
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('group_join_link', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(link).run();
    }
    return { inline_keyboard: [[{ text: "عضویت در گروه", url: link }]] };
  } catch (err) {
    await recordEvent(env, "jozve", "", "error", `join_link: ${err && err.message ? err.message : "unknown"}`);
    return undefined;
  }
}

// پیام شرط عضویت، با دکمه‌ی عضویت در گروه اگه لینک ساخته بشه
export async function sendGate(env, chatId, text) {
  const markup = await groupJoinMarkup(env);
  return tg(env, "sendMessage", { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) });
}

export async function dmIsMember(env, uid) {
  const groupId = await env.DB.prepare("SELECT value FROM settings WHERE key = 'group_id'").first();
  if (!groupId || !groupId.value) return false;
  try {
    const r = await tg(env, "getChatMember", { chat_id: groupId.value, user_id: uid });
    const s = r && r.status;
    if (s === "creator" || s === "administrator" || s === "member") return true;
    return s === "restricted" && !!r.is_member;
  } catch (err) {
    await recordEvent(env, "jozve", "", "error", `getChatMember: ${err && err.message ? err.message : "unknown"}`);
    return false;
  }
}

const dmKey = (uid) => `dm_menu:${uid}`;
async function getDmMenu(env, uid) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(dmKey(uid)).first();
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
async function saveDmMenu(env, uid, state) {
  if (!state) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(dmKey(uid)).run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(dmKey(uid), JSON.stringify(state)).run();
}

function dmMainMarkup() {
  return grid([
    { text: "جزوه‌ها", callback_data: "d:n" },
    { text: "نمونه‌سوال", callback_data: "d:e" },
    { text: "کتاب", callback_data: "d:b" },
    { text: "دوره", callback_data: "d:u" },
    { text: "چنل مفید", callback_data: "d:h" },
  ], [{ text: "بستن", callback_data: "d:x" }]);
}

// کتاب، دوره و چنل مفید دسته‌ی درس ندارن: مستقیم فهرست نام‌ها
const LISTED_LETTERS = ["b", "u", "h"];
async function dmNamesView(env, kind) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]} ORDER BY course LIMIT 60`).all();
  const buttons = results
    .map((r) => r.course)
    .filter((c) => bytes(c) <= MAX_NAME_BYTES)
    .map((c) => ({ text: c, callback_data: `d:o${letterOf(kind)}${c}` }));
  return {
    text: buttons.length ? `${TITLE[kind]}: کدوم؟` : `فعلاً ${TITLE[kind]} ثبت نشده.`,
    markup: grid(buttons, [{ text: "بازگشت", callback_data: "d:m" }, { text: "بستن", callback_data: "d:x" }]),
  };
}

async function dmCategoriesView(env, kind) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]}`).all();
  const map = await categoryMap(env);
  const cats = new Set(results.map((r) => map.get(r.course) || DEFAULT_CATEGORY));
  const ordered = [...CATEGORY_ORDER.filter((c) => cats.has(c)), ...[...cats].filter((c) => !CATEGORY_ORDER.includes(c))];
  const text = ordered.length ? `${TITLE[kind]}: کدوم دسته؟` : `فعلاً ${TITLE[kind]}ی ثبت نشده.`;
  const buttons = ordered
    .filter((c) => bytes(c) <= MAX_CATEGORY_BYTES)
    .map((c) => ({ text: c, callback_data: `d:c${letterOf(kind)}${c}` }));
  return { text, markup: grid(buttons, [{ text: "بازگشت", callback_data: "d:m" }, { text: "بستن", callback_data: "d:x" }]) };
}

async function dmCoursesView(env, kind, cat) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT course FROM ${TABLE[kind]} ORDER BY course`).all();
  const map = await categoryMap(env);
  const buttons = results
    .map((r) => r.course)
    .filter((c) => (map.get(c) || DEFAULT_CATEGORY) === cat && bytes(c) <= MAX_NAME_BYTES)
    .map((c) => ({ text: c, callback_data: `d:o${letterOf(kind)}${c}` }));
  return {
    text: buttons.length ? `${cat}: کدوم درس؟` : "موردی پیدا نشد.",
    markup: grid(buttons, [{ text: "بازگشت", callback_data: `d:${letterOf(kind)}` }, { text: "بستن", callback_data: "d:x" }]),
  };
}

async function dmProfessorsView(env, kind, course) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT professor FROM ${TABLE[kind]} WHERE course = ? ORDER BY professor`
  ).bind(course).all();
  const buttons = results
    .map((r) => r.professor)
    .filter((p) => bytes(p) <= MAX_NAME_BYTES)
    .map((p) => ({ text: p, callback_data: `d:f${letterOf(kind)}${course}|${p}` }));
  const back = LISTED_LETTERS.includes(letterOf(kind))
    ? `d:${letterOf(kind)}`
    : `d:c${letterOf(kind)}${await categoryOf(env, course)}`;
  return {
    text: buttons.length ? `${course}: کدوم استاد؟` : "موردی پیدا نشد.",
    markup: grid(buttons, [{ text: "بازگشت", callback_data: back }, { text: "بستن", callback_data: "d:x" }]),
  };
}

async function dmFilesView(env, kind, course, prof) {
  const username = env.JOZVE_PUBLIC_USERNAME || "";
  const { results } = await env.DB.prepare(
    `SELECT channel_msg_id, title, file_name FROM ${TABLE[kind]} WHERE course = ? AND professor = ? ORDER BY title, id LIMIT ?`
  ).bind(course, prof, DM_LINK_LIMIT).all();
  const back = { text: "بازگشت", callback_data: `d:o${letterOf(kind)}${course}` };
  if (!username) return { text: "لینک کانال تنظیم نشده؛ به ادمین اطلاع بده.", markup: grid([], [back, { text: "بستن", callback_data: "d:x" }]) };
  if (!results.length) return { text: "موردی پیدا نشد.", markup: grid([], [back, { text: "بستن", callback_data: "d:x" }]) };
  const rows = results.map((r, i) => {
    const label = Array.from(r.title || r.file_name || `فایل ${i + 1}`).slice(0, 60).join("");
    return [{ text: label, url: `https://t.me/${username}/${r.channel_msg_id}` }];
  });
  return {
    text: `${course} — ${prof}: روی هر مورد بزن تا در کانال باز شه.`,
    markup: { inline_keyboard: [...rows, [back, { text: "بستن", callback_data: "d:x" }]] },
  };
}

// نمای یک مرحله از منو بر اساس callback
async function dmView(env, data) {
  const t = data[2];
  if (t === "m") return { text: DM_MENU_PROMPT, markup: dmMainMarkup() };
  if (t === "n" || t === "e") return dmCategoriesView(env, kindOfLetter(t));
  if (LISTED_LETTERS.includes(t) && data.length === 3) return dmNamesView(env, kindOfLetter(t));
  const kind = kindOfLetter(data[3]);
  const payload = data.slice(4);
  if (t === "c") return dmCoursesView(env, kind, payload);
  if (t === "o") return dmProfessorsView(env, kind, payload);
  if (t === "f") {
    const [course, ...rest] = payload.split("|");
    return dmFilesView(env, kind, course, rest.join("|"));
  }
  return null;
}

// /start یا /jozve در پیوی کاربر عادی: منوی تازه‌ای ساخته می‌شه و منوی قبلی (اگه بود) پاک می‌شه
export async function openDmMenu(env, uid, text = DM_MENU_PROMPT, host = false) {
  if (!(await dmIsMember(env, uid))) return sendGate(env, uid, DM_NOT_MEMBER);
  const prev = await getDmMenu(env, uid);
  if (prev && prev.msg) await tryDeleteMessage(env, uid, prev.msg);
  if (prev && prev.hostMsg) await tryDeleteMessage(env, uid, prev.hostMsg);
  const main = dmMainMarkup();
  const sent = await tg(env, "sendMessage", { chat_id: uid, text, reply_markup: main });
  const now = nowS();
  await saveDmMenu(env, uid, { msg: sent.message_id, created: now, host });
  await rememberMsg(env, uid, sent.message_id, DM_TTL);
}

// کلیک روی منوی پیوی: فقط صاحب منو و فقط اگه هنوز عضو گروه باشه
// سهمیه‌ی کلیک هر کاربر در منوی پیوی: یک کلیک در ثانیه، با تحمل ۳ کلیک پشت‌سرهم
const DM_CLICK_BURST = 3;
const dmClickKey = (uid) => `dm_clicks:${uid}`;
async function takeDmClick(env, uid) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(dmClickKey(uid)).first();
  let b = null;
  try { b = row && row.value ? JSON.parse(row.value) : null; } catch { b = null; }
  const tokens = Math.min(DM_CLICK_BURST, b ? b.t + (now - b.at) / 1000 : DM_CLICK_BURST);
  if (tokens < 1) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(dmClickKey(uid), JSON.stringify({ t: tokens, at: now })).run();
    return false;
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(dmClickKey(uid), JSON.stringify({ t: tokens - 1, at: now })).run();
  return true;
}

export async function handleDmCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const uid = cq.from.id;
  const alert = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: true });
  if (String(uid) !== String(chatId)) return alert(DM_NOT_OWNER);
  if (!(await takeDmClick(env, uid))) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "لطفاً کمی صبر کن." });
  }
  const state = await getDmMenu(env, uid);
  if (!state || state.msg !== msgId || nowS() > state.created + DM_MAX_LIFE) {
    await tryDeleteMessage(env, chatId, msgId);
    if (state && state.msg === msgId) await saveDmMenu(env, uid, null);
    return alert(DM_EXPIRED);
  }
  if (!(await dmIsMember(env, uid))) {
    await tryDeleteMessage(env, chatId, msgId);
    await saveDmMenu(env, uid, null);
    return alert(DM_NOT_MEMBER);
  }
  const data = cq.data || "";
  if (data === "d:x") {
    await tryDeleteMessage(env, chatId, msgId);
    if (state.hostMsg) await tryDeleteMessage(env, chatId, state.hostMsg);
    await saveDmMenu(env, uid, null);
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  const view = await dmView(env, data);
  if (!view) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const left = Math.max(1, state.created + DM_MAX_LIFE - nowS());
  if (state.host) {
    // اولین جابه‌جایی از منوی خوش‌آمد: متن خوش‌آمد سرِ جاش می‌مونه؛ دکمه‌هاش برداشته و منو زیرش ادامه پیدا می‌کنه
    try {
      await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    } catch (err) {
      console.error("dm_unmark", err && err.message ? err.message : "unknown");
    }
    const sent = await tg(env, "sendMessage", { chat_id: chatId, text: view.text, reply_markup: view.markup });
    await saveDmMenu(env, uid, { msg: sent.message_id, created: state.created, hostMsg: msgId });
    await rememberMsg(env, chatId, sent.message_id, Math.min(DM_TTL, left));
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  try {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text: view.text, reply_markup: view.markup });
  } catch (err) {
    console.error("dm_edit", err && err.message ? err.message : "unknown");
  }
  // هر کلیک TTL رو تمدید می‌کنه، ولی بیشتر از سقف عمر منو نمی‌مونه
  await rememberMsg(env, chatId, msgId, Math.min(DM_TTL, left));
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
}
