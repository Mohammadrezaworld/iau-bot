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

-- لینک‌های مفید (/links)
CREATE TABLE IF NOT EXISTS links (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url   TEXT NOT NULL
);

-- شماره تلفن‌ها (/call)
CREATE TABLE IF NOT EXISTS phones (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  number TEXT NOT NULL
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
