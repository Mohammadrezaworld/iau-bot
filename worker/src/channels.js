// ارسال پست‌های جدید کانال‌ها به گروه. پیام‌ها متن ساده‌ان (بدون parse_mode) تا محتوای کانال نتونه قالب‌بندی تلگرام رو بشکنه.
import { tg, sendMessage } from "./telegram.js";
import { getSetting } from "./public.js";
import { audit } from "./admin.js";
import { normalizeDigits } from "./jalali.js";
import { pushUndo } from "./undo.js";
import { recordEvent } from "./monitor.js";

const CHANNEL_LABELS = {
  "bale:iaut_fani": "بله – آزمایشگاه‌های دانشکده",
  "bale:iautcom": "بله – مدیر گروه کامپیوتر",
  "telegram:fanniBultan": "تلگرام – بولتن دانشکده",
};

export const DEFAULT_KEYWORDS = ["نخواهد شد", "نخواهند شد", "برگزار نمی", "تعطیل", "لغو", "حذف", "اضافه", "مجوز", "امتحان", "انتخاب واحد", "ثبت‌نام", "اطلاعیه", "اصلاحیه", "تغییر", "تایم", "ساعت"];
const MAX_CHUNK = 3000;

const nowUtc = () => Math.floor(Date.now() / 1000);

// نرمال‌سازی برای تطبیق کلمه‌ها: بدون فاصله و نیم‌فاصله، «ي/ك» به «ی/ک»
export function normalizeForMatch(s) {
  return String(s || "")
    .replace(/[‌​\s]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک");
}

// همان منطق scrape_bale.py: فوتر (بازدید و ساعت) حذف می‌شه تا تکراری شناخته بشه
const FOOTER_JS = /(?:\s+[0-9\u06F0-\u06F9]+)+\s+[0-9\u06F0-\u06F9]{1,2}:[0-9\u06F0-\u06F9]{2}\s*$/;
export function cleanPostText(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().replace(FOOTER_JS, "").trim();
}
// پستی که بعد از حذف فوتر کمتر از ۳ حرف داره (فقط عدد و ساعت)
export function isJunkPost(text) {
  return (cleanPostText(text).match(/\p{L}/gu) || []).length < 3;
}

export function isImportant(text, keywords) {
  const t = normalizeForMatch(text);
  return keywords.some((k) => t.includes(normalizeForMatch(k)));
}

// بازه‌ی سکوت از تنظیم quiet (مثلاً "2-6") خونده می‌شه؛ پیش‌فرض ۰۲ تا ۰۶ تهران
export async function inTehranQuietHours(env, now = Date.now()) {
  const raw = await getSetting(env, "quiet", "2-6");
  const [start, end] = String(raw).split("-").map(Number);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", hour12: false }).format(new Date(now))) % 24;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// /set_quiet ۰۲-۰۶ (ساعت شروع و پایان سکوت به وقت تهران)
export async function setQuietCommand(env, chatId, userId, arg) {
  const m = normalizeDigits(String(arg || "").trim()).match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  const a = m ? Number(m[1]) : NaN;
  const b = m ? Number(m[2]) : NaN;
  if (!m || a > 23 || b > 23 || a === b) return sendMessage(env, chatId, "فرمت: /set_quiet ۰۲-۰۶ (ساعت شروع و پایان، به وقت تهران)");
  const prev = await env.DB.prepare("SELECT value FROM settings WHERE key = 'quiet'").first();
  await pushUndo(env, `تغییر ساعت سکوت به ${a}-${b}`, "setting", "quiet", prev ? prev.value : null);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('quiet', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(`${a}-${b}`).run();
  await audit(env, userId, "set_quiet", `${a}-${b}`);
  return sendMessage(env, chatId, `ساعت سکوت روی ${a} تا ${b} تهران تنظیم شد.`);
}

export async function keywordsList(env) {
  const raw = await getSetting(env, "keywords", "");
  if (!raw) return DEFAULT_KEYWORDS;
  try { return JSON.parse(raw); } catch { return DEFAULT_KEYWORDS; }
}

// خروجی: آرایه‌ای از بخش‌ها، هر بخش آرایه‌ای از خط‌ها (تا خط‌ها جدا بمونن و اگه لازم شد جدا فرستاده بشن)
function chunkMessages(lines) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (cur.length ? 1 : 0);
    if (len + add > MAX_CHUNK && cur.length) { chunks.push(cur); cur = [line]; len = line.length; }
    else { cur.push(line); len += add; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// خطاهایی که به خود محتوای یک پیام مربوط‌ان (نه به گروه یا دسترسی ربات)
const CONTENT_ERROR = /too long|text is empty|parse entities|message text/i;
const MAX_LINE = 4000;

// بخش را یک‌جا می‌فرسته. اگه تلگرام به‌خاطر محتوا رد کرد، خط‌ها یکی‌یکی و کوتاه‌شده فرستاده می‌شن
// تا یک پست خراب کل صف رو متوقف نکنه. خطاهای گروه/دسترسی (مثل chat not found) دوباره پرتاب می‌شن
// تا پست‌ها در صف بمونن و چیزی علامت ارسال نخوره.
async function sendLinesSafely(env, groupId, lines, label) {
  try {
    await tg(env, "sendMessage", { chat_id: groupId, text: lines.join("\n"), disable_web_page_preview: true });
    return;
  } catch (err) {
    if (!CONTENT_ERROR.test(err.message || "")) throw err;
  }
  for (const line of lines) {
    const text = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
    try {
      await tg(env, "sendMessage", { chat_id: groupId, text, disable_web_page_preview: true });
    } catch (err) {
      if (!CONTENT_ERROR.test(err.message || "")) throw err;
      await recordEvent(env, "system", "", "error", `send: ${label} — ${err.message}`);
    }
  }
}

// پست‌های ارسال‌نشده‌ی یک کانال (یا همه‌ی کانال‌ها) رو به گروه می‌فرسته
export async function flushPosts(env, source = null, channel = null) {
  if (await inTehranQuietHours(env)) return { skipped: "quiet_hours" };
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return { skipped: "no_group" };

  const where = source ? "WHERE sent_at_utc IS NULL AND source = ? AND channel = ?" : "WHERE sent_at_utc IS NULL";
  const binds = source ? [source, channel] : [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts ${where} ORDER BY source, channel, first_seen_utc, id LIMIT 200`
  ).bind(...binds).all();
  if (!results.length) return { sent: 0 };

  // پست‌های بله: فوتر (بازدید و ساعت) پیش از ارسال حذف می‌شه (ردیف‌های قدیمی هم شامل می‌شن)،
  // و ردیف‌های بی‌متن (فقط عدد/ساعت) بدون ارسال علامت می‌خورن. پست تلگرام دست‌نخورده می‌مونه.
  const toSend = [];
  const junkIds = [];
  for (const p of results) {
    if (p.source !== "bale") {
      toSend.push(p);
    } else if (isJunkPost(p.text)) {
      junkIds.push(p.id);
    } else {
      toSend.push({ ...p, text: cleanPostText(p.text) });
    }
  }
  for (const id of junkIds) {
    await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ?").bind(nowUtc(), id).run();
  }
  if (!toSend.length) return { sent: 0 };

  const keywords = await keywordsList(env);
  const groups = {};
  for (const p of toSend) (groups[`${p.source}:${p.channel}`] ||= []).push(p);

  let sent = 0;
  for (const [key, posts] of Object.entries(groups)) {
    const label = CHANNEL_LABELS[key] || key;
    const important = posts.filter((p) => isImportant(p.text, keywords));
    const normal = posts.filter((p) => !isImportant(p.text, keywords));
    const ordered = [...important, ...normal];

    const lines = [`📰 ${label}`];
    for (const p of ordered) {
      const body = (p.text || "").trim() || "(بدون متن)";
      lines.push(`${important.includes(p) ? "📢 " : "• "}${body}`);
    }
    const chunks = chunkMessages(lines);
    for (const chunk of chunks) {
      await sendLinesSafely(env, groupId, chunk, label);
    }

    // عکس‌ها: آلبوم با حداکثر ۱۰ عکس. اگه تلگرام نتونست بگیره، متن پیام همچنان رفته.
    const photos = ordered.filter((p) => /^https:\/\//.test(p.image_url || "")).slice(0, 10);
    if (photos.length) {
      try {
        await tg(env, "sendMediaGroup", {
          chat_id: groupId,
          media: photos.map((p, i) => ({ type: "photo", media: p.image_url, ...(i === 0 ? { caption: label } : {}) })),
        });
      } catch (err) {
        console.error("photo_error", err && err.message ? err.message : "unknown");
      }
    }

    const ids = ordered.map((p) => p.id);
    for (const id of ids) {
      await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ?").bind(nowUtc(), id).run();
    }
    sent += ids.length;
  }
  return { sent };
}

// /updates: وضعیت آخرین بررسی هر کانال از کش (بدون اسکرپ جدید)
export async function updatesText(env) {
  const { results } = await env.DB.prepare(
    `SELECT source, channel, ran_at_utc, new_count, ok FROM scrape_runs
     WHERE id IN (SELECT MAX(id) FROM scrape_runs GROUP BY source, channel)
     ORDER BY source, channel`
  ).all();
  if (!results.length) return "هنوز بررسی‌ای انجام نشده.";
  const fmt = (ts) => new Date(ts * 1000).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" });
  const lines = ["وضعیت کانال‌ها:"];
  for (const r of results) {
    const label = CHANNEL_LABELS[`${r.source}:${r.channel}`] || `${r.source}:${r.channel}`;
    const state = !r.ok ? "خطا در بررسی" : r.new_count > 0 ? `${r.new_count} پست جدید` : "پست جدیدی نیست";
    lines.push(`• ${label}: ${state} (آخرین بررسی ساعت ${fmt(r.ran_at_utc)})`);
  }
  return lines.join("\n");
}
