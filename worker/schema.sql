-- تنظیمات کلی (کلید/مقدار)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ادمین‌ها (شناسه عددی تلگرام)
CREATE TABLE IF NOT EXISTS admins (
  user_id  INTEGER PRIMARY KEY,
  is_owner INTEGER NOT NULL DEFAULT 0
);

-- تعطیلات رسمی (تاریخ میلادی YYYY-MM-DD)
CREATE TABLE IF NOT EXISTS holidays (
  date  TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT ''
);

-- پست‌های اسکرپ‌شده از بله و تلگرام
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,            -- 'bale' | 'telegram'
  channel      TEXT NOT NULL,
  post_id      TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  first_seen_utc INTEGER NOT NULL,       -- زمان UTC (ثانیه)
  sent_at_utc  INTEGER,                  -- NULL یعنی هنوز به گروه نرفته
  UNIQUE (source, channel, post_id)
);

-- سوابق اجرای اسکرپ (برای /updates و هشدار خطا)
CREATE TABLE IF NOT EXISTS scrape_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  channel     TEXT NOT NULL,
  ran_at_utc  INTEGER NOT NULL,
  new_count   INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1
);



-- جدول مترو (ساعت‌ها به دقیقه از نیمه‌شب)
CREATE TABLE IF NOT EXISTS metro_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_utc INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0,
  data_json   TEXT NOT NULL
);

-- لاگ تغییرات ادمین
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at_utc     INTEGER NOT NULL,
  actor_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);

-- کش پاسخ‌های روزانه (هفته/ترم/باقی‌مانده) برای ریپلای به جواب قبلی
CREATE TABLE IF NOT EXISTS week_cache (
  key         TEXT NOT NULL,            -- مثل "/week|2026-10-12"
  chat_id     INTEGER NOT NULL,
  message_id  INTEGER NOT NULL,
  created_utc INTEGER NOT NULL,
  PRIMARY KEY (key, chat_id)
);

-- ضداسپم: آخرین زمان دستور هر کاربر در گروه
CREATE TABLE IF NOT EXISTS user_cooldowns (
  user_id  INTEGER PRIMARY KEY,
  last_utc INTEGER NOT NULL
);

-- مقادیر پیش‌فرض
INSERT OR IGNORE INTO settings (key, value) VALUES ('semester_start', '2026-09-12');

-- شماره‌های اداری (/call) با دسته
CREATE TABLE IF NOT EXISTS contacts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name     TEXT NOT NULL,
  number   TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- لینک‌های مفید (/links) با دسته
CREATE TABLE IF NOT EXISTS resources (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title    TEXT NOT NULL,
  url      TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- رویدادهای مهم ترم (میان‌ترم، انتخاب واحد، ...)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,              -- YYYY-MM-DD میلادی
  end_date   TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0
);

-- جلوگیری از یادآوری تکراری: هر رویداد فقط یک بار 'pre' و یک بار 'day'
CREATE TABLE IF NOT EXISTS reminder_log (
  event_id INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  PRIMARY KEY (event_id, kind)
);

-- عملیات حذفی منتظر تأیید (۶۰ ثانیه)
CREATE TABLE IF NOT EXISTS pending_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,
  action      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  expires_utc INTEGER NOT NULL
);
