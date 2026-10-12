// ارسال پست‌های جدید کانال‌ها به گروه. پیام‌ها متن ساده‌ان (بدون parse_mode) تا محتوای کانال نتونه قالب‌بندی تلگرام رو بشکنه.
import { tg } from "./telegram.js";
import { getSetting } from "./public.js";

const CHANNEL_LABELS = {
  "bale:iaut_fani": "بله – آزمایشگاه‌های دانشکده",
  "bale:iautcom": "بله – مدیر گروه کامپیوتر",
  "telegram:fanniBultan": "تلگرام – بولتن دانشکده",
};

const DEFAULT_KEYWORDS = ["نخواهد شد", "نخواهند شد", "برگزار نمی", "تعطیل", "لغو", "حذف", "اضافه", "مجوز", "امتحان", "انتخاب واحد", "ثبت‌نام", "اطلاعیه", "اصلاحیه", "تغییر", "تایم", "ساعت"];
const MAX_CHUNK = 3000;

const nowUtc = () => Math.floor(Date.now() / 1000);

// نرمال‌سازی برای تطبیق کلمه‌ها: بدون فاصله و نیم‌فاصله، «ي/ك» به «ی/ک»
export function normalizeForMatch(s) {
  return String(s || "")
    .replace(/[‌​\s]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک");
}

export function isImportant(text, keywords) {
  const t = normalizeForMatch(text);
  return keywords.some((k) => t.includes(normalizeForMatch(k)));
}

export function inTehranQuietHours(now = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", hour12: false }).format(new Date(now)));
  return hour >= 2 && hour < 6;
}

async function keywordsList(env) {
  const raw = await getSetting(env, "keywords", "");
  if (!raw) return DEFAULT_KEYWORDS;
  try { return JSON.parse(raw); } catch { return DEFAULT_KEYWORDS; }
}

function chunkMessages(lines) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).length > MAX_CHUNK && cur) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// پست‌های ارسال‌نشده‌ی یک کانال (یا همه‌ی کانال‌ها) رو به گروه می‌فرسته
export async function flushPosts(env, source = null, channel = null) {
  if (inTehranQuietHours()) return { skipped: "quiet_hours" };
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return { skipped: "no_group" };

  const where = source ? "WHERE sent_at_utc IS NULL AND source = ? AND channel = ?" : "WHERE sent_at_utc IS NULL";
  const binds = source ? [source, channel] : [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts ${where} ORDER BY source, channel, first_seen_utc, id LIMIT 200`
  ).bind(...binds).all();
  if (!results.length) return { sent: 0 };

  const keywords = await keywordsList(env);
  const groups = {};
  for (const p of results) (groups[`${p.source}:${p.channel}`] ||= []).push(p);

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
    for (const text of chunks) {
      await tg(env, "sendMessage", { chat_id: groupId, text, disable_web_page_preview: true });
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
