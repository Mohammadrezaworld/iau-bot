// دسترسی ادمین، لاگ تغییرات و پشتیبان. فقط در DM و فقط برای شناسه‌های مجاز.

const nowUtc = () => Math.floor(Date.now() / 1000);

export async function isAdmin(env, userId) {
  if (String(userId) === String(env.OWNER_ID)) return true;
  const row = await env.DB.prepare("SELECT user_id FROM admins WHERE user_id = ?").bind(userId).first();
  return !!row;
}

export async function isOwner(env, userId) {
  return String(userId) === String(env.OWNER_ID);
}

export async function audit(env, actorId, action, detail = "") {
  await env.DB.prepare(
    "INSERT INTO audit_log (at_utc, actor_id, action, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(nowUtc(), Number(actorId), action, String(detail).slice(0, 500))
    .run();
}

// جدول‌های ماندگار. (نام‌های قبلی links و phones وجود نداشتن و پشتیبان همیشه خطا می‌داد)
// پست‌ها و تصمیم‌های تأیید/ارسال و تاریخچه‌ی اسکرپ هم ماندگارند؛ جدول‌های موقت عمداً نیستند (تست backup_coverage)
export const BACKUP_TABLES = [
  "settings", "admins", "admin_roles", "holidays", "events", "metro_versions",
  "resources", "contacts", "course_categories", "jozve_files", "exam_files", "book_files", "course_files", "channel_files", "album_groups", "audit_log",
  "posts", "post_outcomes", "scrape_batches", "scrape_batch_items", "scrape_runs", "scrape_events",
];

export async function buildBackup(env) {
  const out = { created_utc: nowUtc() };
  for (const t of BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    out[t] = results;
  }
  return out;
}

export async function statusText(env) {
  const count = async (sql) => (await env.DB.prepare(sql).first()).n;
  const posts = await count("SELECT COUNT(*) AS n FROM posts");
  const unsent = await count("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL");
  const admins = await count("SELECT COUNT(*) AS n FROM admins");
  const holidays = await count("SELECT COUNT(*) AS n FROM holidays");
  const events = await count("SELECT COUNT(*) AS n FROM events WHERE archived = 0");
  const contacts = await count("SELECT COUNT(*) AS n FROM contacts");
  const links = await count("SELECT COUNT(*) AS n FROM resources");
  const { keywordsList } = await import("./channels.js");
  const keywords = (await keywordsList(env)).length;
  const metroRows = (await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'metro_active_%'").all()).results.length;
  const { results: runs } = await env.DB.prepare(
    `SELECT source, channel, ran_at_utc, new_count, ok FROM scrape_runs
     WHERE id IN (SELECT MAX(id) FROM scrape_runs GROUP BY source, channel)`
  ).all();
  const runLines = runs.length
    ? runs.map((r) => `- ${r.source}/${r.channel}: ${r.ok ? "موفق" : "ناموفق"}، جدید: ${r.new_count}`)
    : ["- هنوز اسکرپی ثبت نشده"];
  const { healthLines } = await import("./monitor.js");
  return [
    "وضعیت ربات",
    `پست‌های ذخیره‌شده: ${posts} (ارسال‌نشده: ${unsent})`,
    `ادمین‌ها: ${admins + 1} نفر (شامل مالک)`,
    `تعطیلات ثبت‌شده: ${holidays}`,
    `رویدادهای فعال: ${events} · شماره‌ها: ${contacts} · لینک‌ها: ${links}`,
    `کلمات کلیدی: ${keywords} · جدول مترو فعال: ${metroRows} از ۲`,
    "زمان‌بندی اسکرپ: بله هر ۳۰ دقیقه (cron-job.org)، تلگرام هر ۲ ساعت (GitHub)، ساعت سکوت ۰۲ تا ۰۶ تهران",
    "سلامت اسکرپ:",
    ...(await healthLines(env)),
    "آخرین اسکرپ‌ها:",
    ...runLines,
  ].join("\n");
}

export async function logText(env) {
  const { results } = await env.DB.prepare(
    "SELECT at_utc, actor_id, action, detail FROM audit_log ORDER BY id DESC LIMIT 20"
  ).all();
  if (!results.length) return "هنوز تغییری ثبت نشده.";
  return results
    .map((r) => {
      const d = new Date(r.at_utc * 1000).toISOString().replace("T", " ").slice(0, 16);
      return `${d} | ${r.actor_id} | ${r.action}${r.detail ? " | " + r.detail : ""}`;
    })
    .join("\n");
}

// سطح دسترسی: owner (مالک)، full (همه‌ی دستورها)، content (فقط محتوا). ادمین بدون ردیف، full حساب می‌شه.
export async function getRole(env, userId) {
  if (String(userId) === String(env.OWNER_ID)) return "owner";
  const row = await env.DB.prepare("SELECT role FROM admin_roles WHERE user_id = ?").bind(userId).first();
  if (row) return row.role;
  const admin = await env.DB.prepare("SELECT user_id FROM admins WHERE user_id = ?").bind(userId).first();
  return admin ? "full" : null;
}
