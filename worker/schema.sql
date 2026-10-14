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

-- رویدادهای پایش اسکرپ: kind = 'error' | 'health' | 'delivered' (برای /scrape_log و گزارش روزانه)
CREATE TABLE IF NOT EXISTS scrape_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at_utc  INTEGER NOT NULL,
  source  TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  kind    TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS scrape_events_at ON scrape_events (at_utc);

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

-- جریان مرحله‌به‌مرحله‌ی ادمین در DM (افزودن رویداد، شماره، لینک)
CREATE TABLE IF NOT EXISTS admin_sessions (
  user_id     INTEGER PRIMARY KEY,
  flow        TEXT NOT NULL,
  step        INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_utc INTEGER NOT NULL
);

-- پایه‌گذاری یک‌باره: پست‌های قبل از راه‌اندازی ارسال گروه، علامت ارسال‌شده می‌خورن تا سیل پیام نیاد
INSERT INTO settings (key, value) SELECT 'baseline_v1', 'pending' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'baseline_v1');
UPDATE posts SET sent_at_utc = first_seen_utc WHERE sent_at_utc IS NULL AND EXISTS (SELECT 1 FROM settings WHERE key = 'baseline_v1' AND value = 'pending');
UPDATE settings SET value = 'done' WHERE key = 'baseline_v1' AND value = 'pending';

-- سطح دسترسی ادمین‌ها: full (همه‌ی دستورها) یا content (فقط جزوه/شماره/لینک/رویداد)
CREATE TABLE IF NOT EXISTS admin_roles (
  user_id INTEGER PRIMARY KEY,
  role    TEXT NOT NULL
);

-- ضداسپم /metro: هر استفاده‌ی غیرادمین (۳ بار در ۱۰ دقیقه)
CREATE TABLE IF NOT EXISTS metro_usage (
  user_id INTEGER NOT NULL,
  at_utc  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS metro_usage_user ON metro_usage (user_id, at_utc);

-- پیام‌های موقت /metro در گروه (منو و نتیجه) با زمان حذف
CREATE TABLE IF NOT EXISTS metro_messages (
  chat_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  delete_at_utc INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- برگشت تغییرات (/undo): فقط ۵ تغییر آخر نگه داشته می‌شه
CREATE TABLE IF NOT EXISTS undo_stack (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_utc INTEGER NOT NULL,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'setting' | 'holiday'
  key         TEXT NOT NULL,
  before      TEXT
);

-- جزوه‌ها: شماره‌ی پیام کانال خصوصی همراه با درس و استاد. خود فایل داخل تلگرام می‌مونه.
CREATE TABLE IF NOT EXISTS jozve_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course          TEXT NOT NULL,
  professor       TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  file_name       TEXT NOT NULL DEFAULT '',
  file_size       INTEGER NOT NULL DEFAULT 0,
  channel_msg_id  INTEGER NOT NULL UNIQUE,
  created_utc     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jozve_files_course ON jozve_files (course, professor);

-- ضداسپم /jozve: هر استفاده‌ی غیرادمین (۳ بار در ۱۰ دقیقه)
CREATE TABLE IF NOT EXISTS jozve_usage (
  user_id INTEGER NOT NULL,
  at_utc  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jozve_usage_user ON jozve_usage (user_id, at_utc);

-- نمونه‌سوال پایان‌ترم‌ها: جدول جدا از جزوه‌ها؛ ترم در ستون title
CREATE TABLE IF NOT EXISTS exam_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course          TEXT NOT NULL,
  professor       TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  file_name       TEXT NOT NULL DEFAULT '',
  file_size       INTEGER NOT NULL DEFAULT 0,
  channel_msg_id  INTEGER NOT NULL UNIQUE,
  created_utc     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS exam_files_course ON exam_files (course, professor);

-- دسته‌ی هر درس برای منوی /jozve (مثلاً دروس عمومی، معارف، دروس اختصاصی)
CREATE TABLE IF NOT EXISTS course_categories (
  course   TEXT PRIMARY KEY,
  category TEXT NOT NULL
);

-- دسته‌ی درس‌ها از روی جدول‌های ترم‌بندی (ستون نوع درس). تکراری‌ها نادیده گرفته می‌شن، پس تغییرات ادمین حفظ می‌شه.
INSERT OR IGNORE INTO course_categories (course, category) VALUES
  ('زبان فارسی', 'دروس عمومی'),
  ('زبان انگلیسی', 'دروس عمومی'),
  ('تربیت بدنی ۱', 'دروس عمومی'),
  ('تربیت بدنی ۲', 'دروس عمومی'),
  ('دانش خانواده و جمعیت', 'دروس عمومی'),
  ('وصایای امام', 'دروس عمومی'),
  ('ریاضی عمومی ۱', 'دروس پایه'),
  ('ریاضی عمومی ۲', 'دروس پایه'),
  ('فیزیک ۱', 'دروس پایه'),
  ('فیزیک ۲', 'دروس پایه'),
  ('آزمایشگاه فیزیک ۱', 'دروس پایه'),
  ('معادلات دیفرانسیل', 'دروس پایه'),
  ('آمار و احتمال مهندسی', 'دروس پایه'),
  ('فیزیک پیش', 'دروس پایه'),
  ('ریاضی پیش', 'دروس پایه'),
  ('اندیشه اسلامی ۱', 'معارف'),
  ('اندیشه اسلامی ۲', 'معارف'),
  ('انسان در اسلام', 'معارف'),
  ('حقوق اجتماعی و سیاسی در اسلام', 'معارف'),
  ('فلسفه اخلاق', 'معارف'),
  ('اخلاق اسلامی', 'معارف'),
  ('آیین زندگی', 'معارف'),
  ('عرفان عملی اسلام', 'معارف'),
  ('انقلاب اسلامی ایران', 'معارف'),
  ('آشنایی با قانون اساسی جمهوری اسلامی ایران', 'معارف'),
  ('اندیشه سیاسی امام خمینی (ره)', 'معارف'),
  ('تاریخ فرهنگ و تمدن اسلامی', 'معارف'),
  ('تاریخ تحلیلی صدر اسلام', 'معارف'),
  ('تاریخ امامت', 'معارف'),
  ('تفسیر موضوعی قرآن', 'معارف'),
  ('تفسیر موضوعی نهج البلاغه', 'معارف');

-- جدول قدیمی صف webhook (در prod هست؛ حذف نمی‌شه). داده‌هاش یک بار به update_queue منتقل می‌شه.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  state     TEXT NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 1,
  at_utc    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS processed_updates_at ON processed_updates (at_utc);

-- ثبت مهاجرت‌های یک‌باره (برای اجرای امن schema روی هر deploy)
CREATE TABLE IF NOT EXISTS schema_migrations (
  name   TEXT PRIMARY KEY,
  at_utc INTEGER NOT NULL
);

-- صف update های webhook (ماژول updates.js)
CREATE TABLE IF NOT EXISTS update_queue (
  update_id    INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,              -- processing · done · failed · needs_review
  attempts     INTEGER NOT NULL DEFAULT 1,
  lease        TEXT NOT NULL DEFAULT '',
  payload      TEXT,                       -- متن update برای تلاش مجدد (بعد از done پاک می‌شه)
  last_error   TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',   -- error · exhausted · ambiguous · done_write · migrated · owner_applied · owner_not_applied
  notify_state TEXT NOT NULL DEFAULT 'none', -- none · sent · failed
  at_utc       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS update_queue_at ON update_queue (at_utc);
CREATE INDEX IF NOT EXISTS update_queue_state ON update_queue (state);

-- اثرهای ثبت‌شده (DB و ارسال بیرونی). کلید عملیات پایدار است؛ intent یعنی نتیجه نامشخص.
CREATE TABLE IF NOT EXISTS effects (
  op_key     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  state      TEXT NOT NULL,                -- intent · done · failed
  update_id  INTEGER,
  lease      TEXT NOT NULL DEFAULT '',
  result     TEXT NOT NULL DEFAULT '',
  msg_id     INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  at_utc     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS effects_update ON effects (update_id, state);

-- مهاجرت یک‌باره: done قدیمی done می‌مونه؛ بقیه (processing/failed) نامشخص‌اند و برای بررسی مالک میان
INSERT OR IGNORE INTO update_queue (update_id, state, attempts, lease, payload, last_error, reason, at_utc)
  SELECT update_id,
         CASE WHEN state = 'done' THEN 'done' ELSE 'needs_review' END,
         attempts, '', NULL,
         'migrated from processed_updates (state=' || state || ')',
         CASE WHEN state = 'done' THEN '' ELSE 'migrated' END,
         at_utc
  FROM processed_updates
  WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'processed_to_queue_v2');
INSERT OR IGNORE INTO schema_migrations (name, at_utc) VALUES ('processed_to_queue_v2', CAST(strftime('%s', 'now') AS INTEGER));
