// /metro: منوی مرحله‌به‌مرحله‌ی گروه (مبدأ ← مقصد ← نتیجه) و آپلود جدول توسط ادمین در DM.
// وضعیت منو داخل خود دکمه‌هاست (بدون جدول state)؛ فقط درخواست‌کننده می‌تونه از دکمه‌ها استفاده کنه.
import { tg, sendMessage, tryDeleteMessage } from "./telegram.js";
import { isAdmin, audit } from "./admin.js";
import { tehranToday, faDate } from "./calendar.js";
import {
  KIND_LABEL, MAX_FILE_BYTES, parseMetroWorkbook, summarize, tripsFor, minToHM, fa2,
} from "./metro_parse.js";

const RESULT_TTL = 300; // ثانیه
const RATE_WINDOW = 600;
const RATE_MAX = 3;
const nowS = () => Math.floor(Date.now() / 1000);

function tehranNow() {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
  const [h, m] = hm.split(":").map(Number);
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", weekday: "short" }).format(new Date());
  return { iso: tehranToday(), nowMin: (h * 60 + m) % 1440, friday: dow === "Fri" };
}

// جمعه و تعطیلات رسمی از جدول جمعه
async function todayKind(env) {
  const t = tehranNow();
  const hol = await env.DB.prepare("SELECT date FROM holidays WHERE date = ?").bind(t.iso).first();
  return { ...t, kind: t.friday || hol ? "friday" : "regular" };
}

async function activeVersion(env, kind) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`metro_active_${kind}`).first();
  return row ? versionById(env, Number(row.value)) : null;
}

async function versionById(env, id) {
  if (!Number.isInteger(id)) return null;
  const row = await env.DB.prepare("SELECT id, data_json FROM metro_versions WHERE id = ?").bind(id).first();
  return row ? { id: row.id, data: JSON.parse(row.data_json) } : null;
}

// پیام‌های موقت گروه: زمان حذف در جدول، و cron هر دقیقه پاکشون می‌کنه
async function rememberMsg(env, chatId, msgId) {
  await env.DB.prepare(
    `INSERT INTO metro_messages (chat_id, message_id, delete_at_utc) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET delete_at_utc = excluded.delete_at_utc`
  ).bind(chatId, msgId, nowS() + RESULT_TTL).run();
}

async function forgetMsg(env, chatId, msgId) {
  await env.DB.prepare("DELETE FROM metro_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, msgId).run();
}

async function sendTemp(env, chatId, text, markup) {
  const sent = await tg(env, "sendMessage", {
    chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true,
  });
  await rememberMsg(env, chatId, sent.message_id);
}

async function editTemp(env, chatId, msgId, text, markup) {
  try {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: msgId, text, reply_markup: markup, disable_web_page_preview: true,
    });
  } catch (err) {
    // «پیام تغییری نکرده» خطای واقعی نیست
    console.error("metro_edit", err && err.message ? err.message : "unknown");
  }
  await rememberMsg(env, chatId, msgId);
}

const ack = (env, cq, text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });

// دکمه‌ها دو ستونه؛ آخرین ردیف دکمه‌های کمکی
function grid(buttons, tail = []) {
  const rows = [];
  for (let k = 0; k < buttons.length; k += 2) rows.push(buttons.slice(k, k + 2));
  return { inline_keyboard: [...rows, ...(tail.length ? [tail] : [])] };
}

const originText = (v) => `مترو · ${KIND_LABEL[v.data.kind]}\nمبدأ را انتخاب کنید:`;
const destText = (v, i) => `مترو · ${KIND_LABEL[v.data.kind]}\nمبدأ: ${v.data.stations[i]}\nمقصد را انتخاب کنید:`;

function originMarkup(uid, v) {
  const st = v.data.stations;
  const buttons = st.map((name, i) => ({ text: name, callback_data: `m:o:${uid}:${v.id}:${i}` }));
  return grid(buttons, [{ text: "بستن", callback_data: `m:x:${uid}` }]);
}

function destMarkup(uid, v, i) {
  const st = v.data.stations;
  const buttons = st
    .map((name, j) => ({ text: name, callback_data: `m:d:${uid}:${v.id}:${i}:${j}` }))
    .filter((_, j) => j !== i);
  return grid(buttons, [
    { text: "بازگشت", callback_data: `m:s:${uid}:${v.id}` },
    { text: "بستن", callback_data: `m:x:${uid}` },
  ]);
}

const resultMarkup = (uid, v) => ({
  inline_keyboard: [[
    { text: "مسیر جدید", callback_data: `m:s:${uid}:${v.id}` },
    { text: "بستن", callback_data: `m:x:${uid}` },
  ]],
});

function resultText(v, i, j, t, nowMin, iso) {
  const st = v.data.stations;
  const lines = [`مترو: از ${st[i]} به ${st[j]}`, `${faDate(iso)} · ${KIND_LABEL[v.data.kind]}`, ""];
  if (t.total === 0) {
    lines.push("برای این مسیر در این جدول سرویسی ثبت نشده است.");
  } else if (t.upcoming.length === 0) {
    lines.push("سرویس امروز برای این مسیر تمام شده است.");
  } else {
    for (const tr of t.upcoming) {
      lines.push(`• سرویس ${fa2(tr.s)}: حرکت ${fa2(minToHM(tr.dep))} ـ رسیدن به مقصد ${fa2(minToHM(tr.arr))}`);
    }
  }
  lines.push("", "زمان‌ها طبق جدول رسمی است و ممکن است ±۱ دقیقه اختلاف داشته باشد.");
  lines.push(`این پیام ${fa2(RESULT_TTL / 60)} دقیقه دیگر پاک می‌شود.`);
  return lines.join("\n");
}

// دستور /metro در گروه (ربات دستور رو بعد از پاسخ پاک می‌کنه)
export async function handleMetroCommand(env, msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  if (!(await isAdmin(env, uid))) {
    const now = nowS();
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM metro_usage WHERE user_id = ? AND at_utc > ?")
      .bind(uid, now - RATE_WINDOW).first();
    if (r.n >= RATE_MAX) return tryDeleteMessage(env, chatId, msg.message_id); // بی‌صدا
    await env.DB.prepare("INSERT INTO metro_usage (user_id, at_utc) VALUES (?, ?)").bind(uid, now).run();
    await env.DB.prepare("DELETE FROM metro_usage WHERE at_utc < ?").bind(now - 3600).run();
  }

  const t = await todayKind(env);
  const v = await activeVersion(env, t.kind);
  if (!v) {
    await sendTemp(env, chatId, t.kind === "friday"
      ? "جدول جمعه و تعطیلات رسمی هنوز ثبت نشده است."
      : "جدول مترو هنوز ثبت نشده است.");
  } else {
    await sendTemp(env, chatId, originText(v), originMarkup(uid, v));
  }
  await tryDeleteMessage(env, chatId, msg.message_id);
}

// دکمه‌های گروه: m:<action>:<uid>:<versionId>:<i>:<j>
export async function handleMetroCallback(env, cq) {
  const [, action, uidStr, vidStr, x, y] = String(cq.data || "").split(":");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (String(cq.from.id) !== uidStr) return ack(env, cq, "این دکمه‌ها برای درخواست‌کننده‌ی /metro هستند.");

  if (action === "x") {
    await tryDeleteMessage(env, chatId, msgId);
    await forgetMsg(env, chatId, msgId);
    return ack(env, cq);
  }

  const v = await versionById(env, Number(vidStr));
  if (!v) return ack(env, cq, "این جدول دیگر در دسترس نیست. دوباره /metro بزنید.");
  const n = v.data.stations.length;
  const idx = (s) => {
    const k = Number(s);
    return Number.isInteger(k) && k >= 0 && k < n ? k : null;
  };

  if (action === "s") {
    await editTemp(env, chatId, msgId, originText(v), originMarkup(uidStr, v));
  } else if (action === "o") {
    const i = idx(x);
    if (i === null) return ack(env, cq);
    await editTemp(env, chatId, msgId, destText(v, i), destMarkup(uidStr, v, i));
  } else if (action === "d") {
    const i = idx(x);
    const j = idx(y);
    if (i === null || j === null || i === j) return ack(env, cq);
    const now = tehranNow();
    const t = tripsFor(v.data, i, j, now.nowMin, 3);
    await editTemp(env, chatId, msgId, resultText(v, i, j, t, now.nowMin, now.iso), resultMarkup(uidStr, v));
  }
  return ack(env, cq);
}

// حذف پیام‌های موقت منقضی‌شده (هر دقیقه از cron)
export async function cleanupMetroMessages(env) {
  const { results } = await env.DB.prepare(
    "SELECT chat_id, message_id FROM metro_messages WHERE delete_at_utc <= ? LIMIT 100"
  ).bind(nowS()).all();
  for (const r of results) {
    await tryDeleteMessage(env, r.chat_id, r.message_id);
    await forgetMsg(env, r.chat_id, r.message_id);
  }
}

// آپلود جدول در DM: فایل xlsx → پیش‌نمایش → تأیید
export async function handleMetroDocument(env, message) {
  const chatId = message.chat.id;
  const doc = message.document;
  if (!/\.xlsx$/i.test(doc.file_name || "")) return sendMessage(env, chatId, "فقط فایل xlsx جدول مترو قبول است.");
  if ((doc.file_size || 0) > MAX_FILE_BYTES) return sendMessage(env, chatId, "حجم فایل بیشتر از ۲۰ مگابایت است.");

  let buf;
  try {
    const info = await tg(env, "getFile", { file_id: doc.file_id });
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
    if (!res.ok) throw new Error("download");
    buf = await res.arrayBuffer();
  } catch {
    return sendMessage(env, chatId, "دریافت فایل از تلگرام ناموفق بود. دوباره بفرستید.");
  }

  let data;
  try {
    data = await parseMetroWorkbook(buf);
  } catch (err) {
    return sendMessage(env, chatId, `فایل پذیرفته نشد: ${err.message}`);
  }

  const s = summarize(data);
  await env.DB.prepare("DELETE FROM pending_actions WHERE action = 'metro_upload' AND expires_utc < ?").bind(nowS()).run();
  const row = await env.DB.prepare(
    "INSERT INTO pending_actions (actor_id, action, payload, expires_utc) VALUES (?, 'metro_upload', ?, ?) RETURNING id"
  ).bind(message.from.id, JSON.stringify(data), nowS() + 900).first();

  const lines = [
    `پیش‌نمایش جدول «${KIND_LABEL[data.kind]}»`,
    `• ایستگاه‌ها: ${fa2(s.stations)}`,
    ...s.sheets.map((x) => `• قطار در «${x.name}»: ${fa2(x.count)}`),
    `• بازه‌ی حرکت: ${fa2(minToHM(s.first))} تا ${fa2(minToHM(s.last))}`,
    "",
    "با تأیید، این جدول جای نسخه‌ی فعال همین نوع را می‌گیرد.",
  ];
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "تأیید و فعال‌سازی", callback_data: `mu:ok:${row.id}` },
        { text: "لغو", callback_data: `mu:x:${row.id}` },
      ]],
    },
  });
}

export async function handleMetroUploadCallback(env, cq) {
  const [, action, idStr] = String(cq.data || "").split(":");
  const chatId = cq.message.chat.id;
  const p = await env.DB.prepare(
    "SELECT * FROM pending_actions WHERE id = ? AND actor_id = ? AND action = 'metro_upload'"
  ).bind(Number(idStr), cq.from.id).first();
  if (!p || p.expires_utc < nowS()) return ack(env, cq, "این درخواست منقضی شده؛ فایل را دوباره بفرستید.");
  await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(p.id).run();

  if (action !== "ok") return ack(env, cq, "لغو شد");

  const data = JSON.parse(p.payload);
  const row = await env.DB.prepare(
    "INSERT INTO metro_versions (created_utc, is_active, data_json) VALUES (?, 1, ?) RETURNING id"
  ).bind(nowS(), p.payload).first();
  await env.DB.prepare("UPDATE metro_versions SET is_active = 0 WHERE id != ? AND json_extract(data_json, '$.kind') = ?")
    .bind(row.id, data.kind).run();
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(`metro_active_${data.kind}`, String(row.id)).run();
  await audit(env, cq.from.id, "metro_upload", `${data.kind}:${row.id}`);
  await ack(env, cq, "ثبت شد");
  return sendMessage(env, chatId, `جدول «${KIND_LABEL[data.kind]}» فعال شد (نسخه ${fa2(row.id)}).`);
}

export async function metroInfoText(env) {
  const out = [];
  for (const kind of ["regular", "friday"]) {
    const v = await activeVersion(env, kind);
    if (!v) {
      out.push(`${KIND_LABEL[kind]}: ثبت نشده`);
      continue;
    }
    const s = summarize(v.data);
    out.push(`${KIND_LABEL[kind]}: نسخه ${fa2(v.id)} — ${fa2(s.stations)} ایستگاه، ${fa2(s.total)} سرویس`);
  }
  return out.join("\n");
}
