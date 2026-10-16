// ارسال پست‌های جدید کانال‌ها به گروه. پیام‌ها متن ساده‌ان (بدون parse_mode) تا محتوای کانال نتونه قالب‌بندی تلگرام رو بشکنه.
import { tg, sendMessage, sendHtml, escHtml } from "./telegram.js";
import { getSetting } from "./public.js";
import { audit } from "./admin.js";
import { normalizeDigits } from "./jalali.js";
import { pushUndo } from "./undo.js";
import { recordEvent } from "./monitor.js";
import { setOutcome, statusReport } from "./outcomes.js";

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

// توقف دستی ارسال پست‌ها به گروه (تنظیم scrape_paused). پست‌ها همچنان ذخیره می‌شن، فقط ارسال نمی‌شه.
export async function scrapePaused(env) {
  return String(await getSetting(env, "scrape_paused", "0")) === "1";
}

// حالت ارسال: توقف (paused) > خودکار (scrape_auto=1) > تأیید دستی (پیش‌فرض، وقتی تنظیمی نیست)
export async function scrapeMode(env) {
  return (await readModeSnapshot(env)).mode;
}

// یک خواندن از سه تنظیم حالت با هم؛ نوشتن حالت هم یک تراکنش است (writeMode در scrape_mode.js)
// پس خواننده یا حالت قدیمی را می‌بیند یا جدید را؛ cutoff نیمه‌کاره دیده نمی‌شود.
// قفل انتشار خودکار: بدون SCRAPE_AUTO_ALLOWED=1 در محیط deploy، حالت خودکار هرگز مؤثر نیست،
// حتی اگر scrape_auto=1 در D1 مانده باشد.
export function autoAllowed(env) {
  return String(env.SCRAPE_AUTO_ALLOWED || "") === "1";
}

export async function readModeSnapshot(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('scrape_paused', 'scrape_auto', 'scrape_auto_since')"
  ).all();
  const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const paused = String(m.scrape_paused ?? "0") === "1";
  const storedAuto = String(m.scrape_auto ?? "0") === "1";
  const auto = storedAuto && autoAllowed(env);
  const since = Number(m.scrape_auto_since ?? 0);
  return { paused, auto, storedAuto, since, mode: paused ? "stop" : auto ? "auto" : "manual" };
}

export async function setScrapePaused(env, on) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('scrape_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(on ? "1" : "0").run();
}

async function unsentCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").first();
  return Number(row ? row.n : 0);
}

// /scrape_pause · /scrape_resume [skip] · /scrape_status (فقط مالک؛ status برای همه‌ی ادمین‌ها)
export async function scrapeCommand(env, chatId, userId, cmd, arg, owner) {
  if (cmd === "/scrape_status") {
    const paused = await scrapePaused(env);
    return sendMessage(env, chatId, `ارسال به گروه: ${paused ? "متوقف" : "فعال"}\n${await statusReport(env)}`);
  }
  if (!owner) return sendMessage(env, chatId, "این دستور فقط برای مالک ربات است.");
  if (cmd === "/scrape_pause") {
    // /scrape_pause همان حالت «توقف انتشار» پنل است؛ ادامه فقط از همان سرویس (commands.js → resumeCommand)
    await setScrapePaused(env, true);
    await audit(env, userId, "scrape_pause", "");
    return sendMessage(env, chatId, "ارسال پست‌ها به گروه متوقف شد. پست‌ها همچنان ذخیره می‌شن.\nبرای ادامه: /scrape_resume");
  }
  return null;
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

// ورودی: آرایه‌ی بلوک‌ها ({html, plain}). خروجی: آرایه‌ای از بخش‌ها، هر بخش آرایه‌ای از بلوک‌ها
// (تا بلوک‌ها جدا بمونن و اگه لازم شد جدا فرستاده بشن)
function chunkMessages(blocks) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const b of blocks) {
    const add = b.html.length + (cur.length ? 1 : 0);
    if (len + add > MAX_CHUNK && cur.length) { chunks.push(cur); cur = [b]; len = b.html.length; }
    else { cur.push(b); len += add; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// خطاهایی که به خود محتوای یک پیام مربوط‌ان (نه به گروه یا دسترسی ربات)
const CONTENT_ERROR = /too long|text is empty|parse entities|message text/i;
const MAX_LINE = 4000;

// یک واحد = یک پیام تلگرام = یک اثر. اول HTML؛ اگه محتوا رد شد، همان واحد با متن ساده (باز هم یک پیام).
// هیچ‌وقت چند پیام زیر یک اثر فرستاده نمی‌شه، پس تکرار بخش موفق در retry ممکن نیست.
// رد محتوایی (هر دو قالب) قطعی و بدون ارسال است؛ با contentRefused مشخص می‌شه تا caller واحد را تجزیه کند.
// خطاهای گروه/دسترسی و خطای شبکه همان‌طور که بودند پرت می‌شن.
async function sendBlocksSafely(env, groupId, blocks, label, guard = null) {
  const html = blocks.map((b) => b.html).join("\n");
  try {
    return (await sendHtml(env, groupId, html)).message_id;
  } catch (err) {
    if (!CONTENT_ERROR.test(err.message || "")) throw err;
  }
  // تلاش متن ساده هم تماس تازه با تلگرام است: قبل از آن مجوز و سکوت/توقف دوباره بررسی می‌شود
  if (guard) {
    const why = await guard();
    if (why) { const e = new Error(`not sent: ${why}`); e.stopped = why; throw e; }
  }
  const plain = blocks.map((b) => b.plain).join("\n");
  try {
    const res = await tg(env, "sendMessage", { chat_id: groupId, text: plain, disable_web_page_preview: true });
    return res.message_id;
  } catch (err) {
    if (!CONTENT_ERROR.test(err.message || "")) throw err;
    const e = new Error(err.message || "content refused");
    e.refused = true;
    e.contentRefused = true;
    e.label = label;
    throw e;
  }
}

// بلوک یک پست: خط اول بولد (عنوان)، متن داخل کوت؛ کوت‌های بلند قابل باز شدن.
// پست مهم کلاً بولد می‌شه. بدون ایموجی.
function postBlock(p, isImp) {
  const body0 = (p.text || "").trim() || "(بدون متن)";
  const body = body0.length > MAX_LINE ? body0.slice(0, MAX_LINE) + "…" : body0;
  const nl = body.indexOf("\n");
  let first;
  let rest;
  if (nl >= 0) { first = body.slice(0, nl).trim(); rest = body.slice(nl + 1).trim(); }
  else if (body.length <= 120) { first = body; rest = ""; }
  else { first = ""; rest = body; }
  const restHtml = rest ? (isImp ? `<b>${escHtml(rest)}</b>` : escHtml(rest)) : "";
  const inner = [first ? `<b>${escHtml(first)}</b>` : "", restHtml].filter(Boolean).join("\n");
  const expandable = body.length > 200;
  return {
    html: `<blockquote${expandable ? " expandable" : ""}>${inner}</blockquote>`,
    plain: `${isImp ? "" : "• "}${body}`,
  };
}

// بخش‌بندی یک فهرست پست: هر کانال یک بخش (عنوان + پست‌ها + عکس‌ها). مهم‌ها اول می‌آن.
export function buildSections(posts, keywords) {
  const groups = {};
  for (const p of posts) (groups[`${p.source}:${p.channel}`] ||= []).push(p);
  return Object.entries(groups).map(([key, ps]) => {
    const label = CHANNEL_LABELS[key] || key;
    const imp = (p) => isImportant(p.text, keywords);
    const ordered = [...ps.filter(imp), ...ps.filter((p) => !imp(p))];
    const blocks = [{ html: `<b>${escHtml(label)}</b>`, plain: label }];
    for (const p of ordered) blocks.push({ ...postBlock(p, imp(p)), postId: p.id });
    const photos = ordered.filter((p) => /^https:\/\//.test(p.image_url || "")).slice(0, 10);
    return { key, label, blocks, photos, ids: ordered.map((p) => p.id) };
  });
}

export { chunkMessages };

// ارسال یک بخش از پیام‌ها به گروه؛ شناسه‌ی آخرین پیام تلگرام رو برمی‌گردونه
export async function sendChunk(env, groupId, blocks, label, guard = null) {
  return sendBlocksSafely(env, groupId, blocks, label, guard);
}

// عکس‌های یک کانال: یک عکس با sendPhoto، دو تا ده عکس با sendMediaGroup (آلبوم یک‌عکسی معتبر نیست).
// خطای قطعی تلگرام پرت می‌شه (refused)؛ خطای مبهم هم همین‌طور؛ caller تصمیم می‌گیره.
// captionText: متن پست زیر یک عکس (بدون قالب، زیر ۱۰۲۴ کاراکتر)؛ اگه نباشه، برچسب کانال
export async function sendPhotos(env, groupId, label, photos, captionText = null) {
  if (photos.length === 1) {
    const res = await tg(env, "sendPhoto", { chat_id: groupId, photo: photos[0].image_url, caption: captionText || label });
    return res && res.message_id ? res.message_id : null;
  }
  const res = await tg(env, "sendMediaGroup", {
    chat_id: groupId,
    media: photos.map((p, i) => ({ type: "photo", media: p.image_url, ...(i === 0 ? { caption: label } : {}) })),
  });
  return Array.isArray(res) && res[0] ? res[0].message_id : null;
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
