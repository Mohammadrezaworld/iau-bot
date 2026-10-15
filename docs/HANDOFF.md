# Handoff: iaut-bot — تأیید دستی اسکرپ، پنل حالت ارسال، قفل خودکار

## ۱. وضعیت در یک نگاه
- ریپو: `Mohammadrezaworld/iaut-bot` (مسیر محلی: `/home/claude/iaut-bot`، ورکر در `worker/`)
- PR: #1 از `feat/scrape-batch-approval` به `main`
- آخرین commit روی شاخه: `0a20073`
- **merge: انجام نشده. deploy: انجام نشده (از چت قبلی هیچ deploy‌ای نبوده).**
- webhook ربات اصلی: دست‌نخورده. گروه یا محیط تست جدا: هنوز ساخته نشده.
- قانون کاری: **merge و deploy فقط با تأیید صریح کاربر.**

## ۲. commitهای PR (از قدیم به جدید)
1. `a26aeee` تأیید دسته‌ای اسکرپ قبل از ارسال به گروه
2. `c96c3be` ignore local wrangler state
3. `7e57f8c` بازیابی ایمن دسته‌ی ناقص و وضعیت نهایی پست‌ها
4. `07414b3` مرحله ۱ (هفت ایراد تأیید دسته‌ها) + مرحله ۲ (پنل حالت)
5. `9052c85` اصلاح تکمیلی (N1–N6 از بررسی مستقل)
6. `0a20073` R1 (دسته‌ی متوقف‌شده پیش از شروع)، R2 (nonce یکتا)، قفل انتشار خودکار

## ۳. معماری مختصر
- **دسته‌ها:** `scrape_batches` (state: pending|sending|sent|rejected|expired|empty)، `scrape_batch_items` (post_id، batch_id، unit).
  - پست جدید → `prepareBatch` → یک دسته pending → پیش‌نمایش برای مالک با `sb:s|r:<bid>`.
  - `approveBatch`: CAS با `pending→sending`، سپس واحد به واحد: قبل از هر تماس تازه `stopReason` (سکوت/توقف/مجوز خودکار)، و `effects` برای هر واحد (intent → done/failed).
  - واحد مبهم (AmbiguousError) خودکار تکرار نمی‌شود؛ در /review با `rv:*` تعیین تکلیف می‌شود.
- **effects:** op_key، state (intent|done|failed)، lease؛ `claimExternal`، `finishExternal`.
- **update_queue:** صف updateها با lease. شناسه‌ی منفی = ارسال خودکار (`autoApprove`)، payload شامل `batch` و `epoch`.
- **post_outcomes:** delivered، owner_applied، telegram_refused، held_flood، skipped_resume، junk، baseline، old، undated، dry_run (اولین نتیجه برنده است).
- **حالت ارسال (`scrapeMode`):** `stop` (اگر scrape_paused=1) > `auto` (اگر scrape_auto=1 **و** `SCRAPE_AUTO_ALLOWED=1` در env) > `manual` (پیش‌فرض).
  - `readModeSnapshot` هر سه تنظیم را با هم می‌خواند؛ `writeMode` در یک تراکنش `env.DB.batch` می‌نویسد.
- **خودکار:** `scrape_auto_since` (cutoff) — فقط پست‌های با `first_seen_utc > since` خودکار می‌روند. `ctx.auto` و `ctx.epoch` در هر تماس تازه احراز می‌شوند.
- **تأیید خودکار:** nonce تصادفی (UUID) در `scrape_auto_token` به شکل `nonce|issuedAt`؛ TTL = ۳۰۰ ثانیه؛ مصرف اتمیک با `UPDATE … WHERE value = ?`.

## ۴. تنظیمات (جدول settings)
| کلید | معنی | پیش‌فرض |
|---|---|---|
| `scrape_paused` | 1 = توقف انتشار | 0 |
| `scrape_auto` | 1 = خودکار (فقط با قفل باز) | 0 |
| `scrape_auto_since` | cutoff خودکار (unix ثانیه) | — |
| `scrape_auto_token` | nonce|زمان تأیید خودکار | '' |
| `quiet` | بازه‌ی سکوت تهران | 2-6 |
| `group_id` | شناسه‌ی گروه | — |

- قفل خودکار: متغیر محیطی `SCRAPE_AUTO_ALLOWED` (در `wrangler.toml` **تنظیم نشده**؛ پیش‌فرض بسته). مقدار D1 قفل را دور نمی‌زند.

## ۵. دستورها و callbackها
- مالک (پیوی): `/review`، `/retry_update <id>`، `/resolve_update <id> applied|not_applied`، `/scrape_settings`، `/scrape_status`، `/scrape_pause`، `/scrape_resume [all]`.
  - `/scrape_resume` فقط از حالت توقف کار می‌کند: پیش‌فرض معوق‌ها کنار گذاشته؛ `all` = پیشنهاد معوق‌ها برای تأیید (هیچ‌وقت خودکار نمی‌فرستد).
- callbackها: `sb:s|c|k|r:<bid>` (دسته)، `rv:r|a|n:<id>` (فهرست بررسی)، `ss:manual|stop|m|locked`، `ss:auto`، `ss:autoy:<nonce>`، `ss:go:<target>:<backlog>[:<nonce>]`.

## ۶. تست‌ها (داخل مخزن: `worker/test/`)
- اجرای همه: `node worker/test/run.mjs` (از ریشه‌ی ریپو). runner هر suite را با `noon_preload.cjs` (ساعت ۱۲ تهران) و DB موقت اجرا می‌کند و با `judge.mjs` قضاوت می‌کند.
- آخرین نتیجه (`0a20073`): judge_selftest 6 · webhook_v2 50 · batch_approval 70 · scrape_mode 60 · flood_guard 16 · dm_menu 38 · group_moved 14 · group_guidance 6 · quiet_all کامل. **همه OK.**
- scrape_mode شامل M0–M12 (پنل و تغییر حالت)، R0–R12 (بازتولید ایرادهای بررسی‌ها + قفل + nonce).
- mock تلگرام در هر suite: `G.sent`، `G.gc`، `G.failAt`، `G.fail`، `G.dropToken`، `G.photoFail`، `G.quietAfterOne`، `G.afterOne`، `G.htmlThenQuiet`؛ ساعت با `clock.ms`.
- D1 محلی: `WRANGLER_SEND_METRICS=false npx --yes wrangler@3.114.17 d1 execute iaut-db --local --file=schema.sql` (۴۸ statement، دو بار موفق).
- **تست‌های SQLite/mock و D1 محلی هستند. تست آنلاین، تلگرام واقعی، چند Worker و گروه تست هنوز اجرا نشده‌اند.**

## ۷. هنوز باز (عمداً خارج از این PR)
- wizard: A2 (retry ورودی را دوباره مصرف می‌کند)، A5 (callbackها به session/step bind نیستند)، A6 (effect ویزارد در /review نیست)
- محدودیت کلیک DM: B2 (read-then-write غیراتمی)، B3 (منوی تکراری)، B4 (cooldown مشترک /week)
- مترو: B1 (آپلود بدون بررسی نقش فعلی)
- A3 (resolve نسخه‌ی جدید را بازنویسی می‌کند)، A4 (reclaim بدون مالکیت صف)
- D2: یادآوری‌ها محافظ سکوت ندارند (`reminders.js` دست‌نخورده)
- D3: بکاپ ناکامل
- C1–C3: شکاف‌های برنامه
- effects خارج از دسته‌ها (copy-jozve) تضمین `finishExternal` ندارند

## ۸. محدودیت‌های شناخته‌شده
- همزمانی و اتمیک بودن نوشتن حالت فقط روی SQLite محلی تست شده، نه D1 واقعی با چند Worker.
- `tg()` تلاش داخلی ندارد؛ اگر اضافه شود، guard تماس تازه باید حفظ شود.
- `effects` و `post_outcomes` بدون retention رشد می‌کنند.
- پیش‌نمایش مالک عکس را نشان نمی‌دهد؛ شناسه‌ی پیام هر عکس ذخیره نمی‌شود.
- پست‌های سیل‌شده (`held_flood`) مسیر ارسال مجدد ندارند.

## ۹. مانده تا merge (به ترتیب، هر کدام با تأیید کاربر)
1. بازبینی محدود R1، R2 و قفل خودکار (اختیاری؛ کاربر تصمیم می‌گیرد).
2. ساخت محیط تست جدا: Worker و D1 جدا، ربات تستی، گروه تست خصوصی، `OWNER_ID` = مالک؛ `SCRAPE_AUTO_ALLOWED` تنظیم نشود.
3. تست دستی روی محیط تست: متن، تک‌عکس، آلبوم، رد/تأیید، تغییر حالت، سکوت، خطای واقعی، /review.
4. تست واقعی D1 و چند Worker.
5. فعال‌سازی خودکار فقط با تأیید جداگانه.

## ۱۰. ترجیحات کاربر
- زبان: فارسی. پاسخ کوتاه و مستقیم؛ تعداد تست‌ها را به‌صورت جدا برای هر محیط گزارش کنید.
- ZIP سورس commit و خروجی تست را همراه هر تحویل بدهید.
- بدون merge یا deploy بدون تأیید صریح.
- ایرادهای قدیمی را با این PR ترکیب نکنید؛ صریحاً «باز» گزارش شوند.
