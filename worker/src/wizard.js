// افزودن مرحله‌به‌مرحله‌ی رویداد، شماره و لینک در DM، و حذف با دکمه (فقط ادمین).
import { tg, sendMessage } from "./telegram.js";
import { audit } from "./admin.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";
import { faDate } from "./calendar.js";
import { dbEffect } from "./effects.js";

const nowUtc = () => Math.floor(Date.now() / 1000);

const KINDS = { exam: "امتحان", midterm: "میان‌ترم", selection: "انتخاب واحد", adddrop: "حذف و اضافه", other: "سایر" };

const FLOWS = {
  event: [
    { key: "start", prompt: "تاریخ شروع رو شمسی بنویس (مثلاً ۱۴۰۵-۰۷-۲۸).", parse: (t) => parseDateInput(t) || null, err: "تاریخ درست نیست. مثلاً ۱۴۰۵-۰۷-۲۸" },
    { key: "end", prompt: "تاریخ پایان رو بنویس، یا «یک روزه» رو بزن.", optional: true, parse: (t) => parseDateInput(t) || null, err: "تاریخ درست نیست. یا بنویس یا دکمه‌ی «یک روزه» رو بزن." },
    { key: "title", prompt: "عنوان رویداد؟ (مثلاً میان‌ترم ریاضی)", parse: (t) => (t.length >= 2 ? t : null), err: "عنوان خیلی کوتاهه." },
    { key: "kind", prompt: "نوع رویداد رو انتخاب کن:", buttons: "kind", parse: null },
  ],
  call: [
    { key: "category", prompt: "دسته‌ی شماره؟ (مثلاً آموزش، امور دانشجویی)", parse: (t) => (t.length >= 2 ? t : null), err: "دسته خیلی کوتاهه." },
    { key: "name", prompt: "نام واحد یا شخص؟ (مثلاً آموزش کامپیوتر)", parse: (t) => (t.length >= 2 ? t : null), err: "نام خیلی کوتاهه." },
    { key: "number", prompt: "شماره؟ (مثلاً ۰۴۱۳۱۹۶۶۱۳۱)", parse: (t) => (/^[0-9+\-]{6,20}$/.test(normalizeDigits(t).replace(/\s/g, "")) ? normalizeDigits(t).replace(/\s/g, "") : null), err: "شماره درست نیست. فقط رقم بنویس." },
    { key: "note", prompt: "یادداشت؟ (اختیاری) یا «بدون یادداشت» رو بزن.", optional: true, parse: (t) => t, err: "" },
  ],
  link: [
    { key: "category", prompt: "دسته‌ی لینک؟ (مثلاً آموزشیار، کانال‌ها)", parse: (t) => (t.length >= 2 ? t : null), err: "دسته خیلی کوتاهه." },
    { key: "title", prompt: "عنوان لینک؟", parse: (t) => (t.length >= 2 ? t : null), err: "عنوان خیلی کوتاهه." },
    { key: "url", prompt: "لینک رو بفرست (باید با https شروع بشه).", parse: (t) => (/^https:\/\/\S+$/.test(t) ? t : null), err: "فقط لینک https قبول می‌شه." },
    { key: "note", prompt: "یادداشت؟ (اختیاری) یا «بدون یادداشت» رو بزن.", optional: true, parse: (t) => t, err: "" },
  ],
};

const kindButtons = () => ({
  inline_keyboard: [
    Object.entries(KINDS).slice(0, 2).map(([k, v]) => ({ text: v, callback_data: `w:kind:${k}` })),
    Object.entries(KINDS).slice(2, 4).map(([k, v]) => ({ text: v, callback_data: `w:kind:${k}` })),
    [{ text: KINDS.other, callback_data: "w:kind:other" }],
  ],
});

const skipButton = { inline_keyboard: [[{ text: "یک روزه / بدون یادداشت", callback_data: "w:skip" }]] };
const confirmButtons = { inline_keyboard: [[{ text: "ثبت", callback_data: "w:ok" }, { text: "لغو", callback_data: "w:cancel" }]] };

async function getSession(env, userId) {
  return env.DB.prepare("SELECT * FROM admin_sessions WHERE user_id = ?").bind(userId).first();
}
async function saveSession(env, userId, flow, step, data) {
  await env.DB.prepare(
    `INSERT INTO admin_sessions (user_id, flow, step, data, updated_utc) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, updated_utc = excluded.updated_utc`
  ).bind(userId, flow, step, JSON.stringify(data), nowUtc()).run();
}
async function clearSession(env, userId) {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
}

function summary(flow, data) {
  if (flow === "event") {
    const range = data.end && data.end !== data.start ? `${faDate(data.start)} تا ${faDate(data.end)}` : faDate(data.start);
    return `رویداد: ${data.title}\nتاریخ: ${range}\nنوع: ${data.kind}`;
  }
  if (flow === "call") return `دسته: ${data.category}\nنام: ${data.name}\nشماره: ${data.number}${data.note ? "\nیادداشت: " + data.note : ""}`;
  return `دسته: ${data.category}\nعنوان: ${data.title}\nلینک: ${data.url}${data.note ? "\nیادداشت: " + data.note : ""}`;
}

// دسته‌های موجود به‌صورت دکمه (فقط برای شماره و لینک)؛ نام جدید هم با تایپ قابل وارده
async function categoryButtons(env, flow) {
  const table = flow === "call" ? "contacts" : "resources";
  const { results } = await env.DB.prepare(`SELECT DISTINCT category FROM ${table} ORDER BY category LIMIT 12`).all();
  const cats = results.map((r) => r.category).filter((c) => new TextEncoder().encode(c).length <= 50);
  if (!cats.length) return null;
  const rows = [];
  for (let k = 0; k < cats.length; k += 2) {
    rows.push(cats.slice(k, k + 2).map((c) => ({ text: c, callback_data: `w:cat:${c}` })));
  }
  return { inline_keyboard: rows };
}

async function askStep(env, chatId, flow, step) {
  const s = FLOWS[flow][step];
  const opts = {};
  if (s.buttons === "kind") opts.reply_markup = kindButtons();
  else if (s.optional) opts.reply_markup = skipButton;
  else if (s.key === "category" && (flow === "call" || flow === "link")) {
    const m = await categoryButtons(env, flow);
    if (m) opts.reply_markup = m;
  }
  return tg(env, "sendMessage", { chat_id: chatId, text: s.prompt, ...opts });
}

export async function startWizard(env, userId, chatId, flow) {
  // شناسه‌ی یکتای جلسه از زمان شروع: retry همون جلسه همون کلید رو داره، جلسه‌ی مستقل کلید جدا
  await saveSession(env, userId, flow, 0, { _sid: `${Date.now()}-${crypto.randomUUID()}` });
  return askStep(env, chatId, flow, 0);
}

// ذخیره‌ی مقدار یک مرحله و رفتن به مرحله‌ی بعد (یا تأیید)
async function advance(env, userId, chatId, sess, value, mid = null) {
  const data = JSON.parse(sess.data);
  const s = FLOWS[sess.flow][sess.step];
  data[s.key] = value;
  // شناسه‌ی پیام متنی که این مرحله را پر کرد؛ retry همان پیام دوباره مصرفش نمی‌کند
  if (mid !== null) data._lastMid = mid;
  // رویداد یک‌روزه: پایان = شروع
  if (sess.flow === "event" && s.key === "end" && !value) data.end = data.start;
  const next = sess.step + 1;
  if (next < FLOWS[sess.flow].length) {
    await saveSession(env, userId, sess.flow, next, data);
    return askStep(env, chatId, sess.flow, next);
  }
  await saveSession(env, userId, sess.flow, next, data);
  return tg(env, "sendMessage", { chat_id: chatId, text: `خلاصه:\n${summary(sess.flow, data)}\n\nثبت بشه؟`, reply_markup: confirmButtons });
}

// متن ادمین وقتی جریان فعاله. اگه جریان نبود، false برمی‌گردونه.
export async function handleWizardText(env, message) {
  const userId = message.from.id;
  const sess = await getSession(env, userId);
  if (!sess) return false;
  if (JSON.parse(sess.data || "{}")._lastMid === message.message_id) return true; // retry همان پیام
  const text = normalizeDigits((message.text || "").trim());
  if (text.startsWith("/")) { await clearSession(env, userId); return false; }
  if (sess.flow === "edit") return handleEditText(env, message, sess, text);

  const s = FLOWS[sess.flow][sess.step];
  if (!s) return false;
  if (s.buttons) {
    await sendMessage(env, message.chat.id, "یکی از گزینه‌های زیر رو بزن.");
    return true;
  }
  const value = s.parse(text);
  if (value === null) {
    await sendMessage(env, message.chat.id, s.err);
    return true;
  }
  await advance(env, userId, message.chat.id, sess, value, message.message_id);
  return true;
}

// ویرایش شماره یا لینک: مقدار جدید فیلد انتخابی
const EDIT_FIELDS = {
  call: { category: ["دسته", (t) => t.length >= 2], name: ["نام", (t) => t.length >= 2], number: ["شماره", (t) => /^[0-9+\-]{6,20}$/.test(t.replace(/\s/g, ""))], note: ["یادداشت", () => true] },
  link: { category: ["دسته", (t) => t.length >= 2], title: ["عنوان", (t) => t.length >= 2], url: ["لینک", (t) => /^https:\/\/\S+$/.test(t)], note: ["یادداشت", () => true] },
};
const EDIT_TABLE = { call: "contacts", link: "resources" };
const EDIT_COLUMN_OK = { call: ["category", "name", "number", "note"], link: ["category", "title", "url", "note"] };

export async function editList(env, chatId, type) {
  const table = EDIT_TABLE[type];
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 20`).all();
  if (!results.length) return sendMessage(env, chatId, "چیزی برای ویرایش نیست.");
  const rows = results.map((r) => {
    const label = type === "call" ? r.name : r.title;
    return [{ text: `✏️ ${label}`.slice(0, 60), callback_data: `ed:p:${type}:${r.id}` }];
  });
  rows.push([{ text: "بستن", callback_data: "x:c" }]);
  return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم ویرایش بشه؟", reply_markup: { inline_keyboard: rows } });
}

async function handleEditText(env, message, sess, text) {
  const d = JSON.parse(sess.data);
  const [label, ok] = EDIT_FIELDS[d.type][d.field];
  const chatId = message.chat.id;
  const value = d.field === "note" && (text === "بدون یادداشت" || text === "-") ? "" : text;
  if (!ok(value)) {
    await sendMessage(env, chatId, `${label} درست نیست. دوباره بفرست.`);
    return true;
  }
  const normalized = d.field === "number" ? value.replace(/\s/g, "") : value;
  await env.DB.prepare(`UPDATE ${EDIT_TABLE[d.type]} SET ${d.field} = ? WHERE id = ?`).bind(normalized, Number(d.id)).run();
  await audit(env, message.from.id, `${d.type}_edit_${d.field}`, String(d.id));
  await clearSession(env, message.from.id);
  await sendMessage(env, chatId, `${label} ویرایش شد.`);
  return true;
}

// دکمه‌ها: w:skip, w:kind:<k>, w:ok, w:cancel، دسته: w:cat:<نام>، ویرایش: ed:p:<type>:<id> و ed:f:<type>:<id>:<field>
// و حذف: rm:<type>:<id> و rmy:<type>:<id>
export async function handleCallback(env, cq) {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const answer = (text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });

  if (data.startsWith("ed:")) {
    const parts = data.split(":");
    if (parts[1] === "p") {
      const [, , type, id] = parts;
      if (!EDIT_TABLE[type]) return answer();
      const row = await env.DB.prepare(`SELECT id FROM ${EDIT_TABLE[type]} WHERE id = ?`).bind(Number(id)).first();
      if (!row) return answer("این مورد دیگه نیست");
      await answer();
      const fields = EDIT_COLUMN_OK[type].map((f) => ({
        text: EDIT_FIELDS[type][f][0], callback_data: `ed:f:${type}:${id}:${f}`,
      }));
      return tg(env, "sendMessage", {
        chat_id: chatId, text: "کدوم فیلد عوض بشه؟",
        reply_markup: { inline_keyboard: [fields.slice(0, 2), fields.slice(2)] },
      });
    }
    if (parts[1] === "f") {
      const [, , type, id, field] = parts;
      if (!EDIT_FIELDS[type] || !EDIT_FIELDS[type][field]) return answer();
      await saveSession(env, userId, "edit", 0, { type, id, field });
      await answer();
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: `مقدار جدید «${EDIT_FIELDS[type][field][0]}» رو بفرست${field === "note" ? " (یا «بدون یادداشت»)" : ""}.`,
        reply_markup: { inline_keyboard: [[{ text: "لغو", callback_data: "w:cancel" }]] },
      });
    }
    return answer();
  }

  if (data.startsWith("w:cat:")) {
    const sess = await getSession(env, userId);
    const cat = data.slice(6);
    if (!sess || !FLOWS[sess.flow] || FLOWS[sess.flow][sess.step]?.key !== "category") return answer("این جریان دیگه فعال نیست");
    await answer();
    return advance(env, userId, chatId, sess, cat);
  }

  // انتخاب سطح دسترسی ادمین جدید (فقط مالک)
  if (data.startsWith("adm:")) {
    if (String(userId) !== String(env.OWNER_ID)) return answer();
    const [, role, id] = data.split(":");
    if (!["full", "content"].includes(role) || !/^\d{5,15}$/.test(id || "")) return answer();
    await env.DB.prepare("INSERT OR IGNORE INTO admins (user_id, is_owner) VALUES (?, 0)").bind(Number(id)).run();
    await env.DB.prepare("INSERT INTO admin_roles (user_id, role) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role")
      .bind(Number(id), role).run();
    await audit(env, userId, "admin_add", `${id}:${role}`);
    await answer("ثبت شد");
    return tg(env, "sendMessage", { chat_id: chatId, text: `ادمین ${id} با سطح ${role === "full" ? "کامل" : "محتوا"} اضافه شد.` });
  }

  if (data.startsWith("rm:") || data.startsWith("rmy:")) {
    const [prefix, type, id] = data.split(":");
    const table = { event: "events", call: "contacts", link: "resources" }[type];
    if (!table) return answer();
    if (prefix === "rm") {
      const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(Number(id)).first();
      if (!row) return answer("پیدا نشد");
      const label = row.title || row.name;
      await answer();
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: `حذف «${label}» تأیید بشه؟`,
        reply_markup: { inline_keyboard: [[{ text: "بله، حذف", callback_data: `rmy:${type}:${id}` }, { text: "نه", callback_data: "w:cancel" }]] },
      });
    }
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(Number(id)).run();
    await audit(env, userId, `${type}_remove`, id);
    await answer("حذف شد");
    return tg(env, "sendMessage", { chat_id: chatId, text: "حذف شد." });
  }

  const sess = await getSession(env, userId);
  if (data === "w:cancel") {
    await clearSession(env, userId);
    await answer();
    return tg(env, "sendMessage", { chat_id: chatId, text: "لغو شد." });
  }
  if (!sess) return answer("این جریان دیگه فعال نیست");

  // دکمه‌ی تأیید فقط در مرحله‌ی خلاصه (بعد از آخرین مرحله) معنی دارد؛ دکمه‌ی قدیمی جلسه‌ی دیگه اثر نداره
  if (data === "w:ok" && sess.step !== FLOWS[sess.flow].length) return answer("این مرحله دیگه فعال نیست");
  if (data === "w:ok") {
    const d = JSON.parse(sess.data);
    const { _sid, _lastMid, ...fields } = d;
    // جلسه‌ی قدیمی (قبل از شناسه): کلید پایدار نداره؛ بدون ثبت، دوباره شروع کنه
    if (!_sid) {
      await clearSession(env, userId);
      await answer("این جلسه قدیمیه");
      return tg(env, "sendMessage", { chat_id: chatId, text: "این جلسه قدیمی شده؛ دوباره از اول شروع کن." });
    }
    // کلید پایدار: شناسه‌ی جلسه. retry همون جلسه همون کلید؛ دو جلسه‌ی مستقل با داده‌ی یکسان کلید متفاوت دارن
    const opKey = `wizard:${userId}:${sess.flow}:${_sid}`;
    let eff;
    if (sess.flow === "event") {
      eff = await dbEffect(env, opKey, "events",
        { table: "events", cols: ["start_date", "end_date", "title", "kind"], vals: [d.start, d.end || d.start, d.title, d.kind] }, `event ${d.start} ${d.title}`);
    } else if (sess.flow === "call") {
      eff = await dbEffect(env, opKey, "contacts",
        { table: "contacts", cols: ["category", "name", "number", "note"], vals: [d.category, d.name, d.number, d.note || ""] }, `call ${d.category} | ${d.name}`);
    } else {
      eff = await dbEffect(env, opKey, "resources",
        { table: "resources", cols: ["category", "title", "url", "note"], vals: [d.category, d.title, d.url, d.note || ""] }, `link ${d.category} | ${d.title}`);
    }
    if (!eff.created) {
      await clearSession(env, userId);
      await answer("قبلاً ثبت شده");
      return tg(env, "sendMessage", { chat_id: chatId, text: "این مورد قبلاً ثبت شده بود." });
    }
    await audit(env, userId, `${sess.flow}_add`, JSON.stringify(fields).slice(0, 300));
    await clearSession(env, userId);
    await answer("ثبت شد");
    return tg(env, "sendMessage", { chat_id: chatId, text: "ثبت شد." });
  }

  if (data === "w:skip" && FLOWS[sess.flow][sess.step]?.optional) {
    await answer();
    // رویداد: خالی یعنی یک‌روزه؛ شماره و لینک: خالی یعنی بدون یادداشت
    return advance(env, userId, chatId, sess, "");
  }

  if (data.startsWith("w:kind:") && sess && sess.flow === "event" && FLOWS.event[sess.step]?.key === "kind") {
    const k = data.split(":")[2];
    await answer();
    return advance(env, userId, chatId, sess, KINDS[k] || KINDS.other);
  }

  return answer();
}

// لیست با دکمه‌ی حذف
export async function removeList(env, chatId, type) {
  const table = { event: "events", call: "contacts", link: "resources" }[type];
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 20`).all();
  if (!results.length) return sendMessage(env, chatId, "چیزی برای حذف نیست.");
  const rows = results.map((r) => {
    const label = type === "event" ? `${faDate(r.start_date)} — ${r.title}` : type === "call" ? `${r.name}` : r.title;
    return [{ text: `❌ ${label}`.slice(0, 60), callback_data: `rm:${type}:${r.id}` }];
  });
  rows.push([{ text: "بستن", callback_data: "x:c" }]);
  return tg(env, "sendMessage", { chat_id: chatId, text: "کدوم حذف بشه؟", reply_markup: { inline_keyboard: rows } });
}
