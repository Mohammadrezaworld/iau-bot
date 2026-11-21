// اجرای همه‌ی تست‌های worker. نیاز به Node 22+ (node:sqlite). ساعت روی ۱۲:۰۰ تهران ثابت می‌شه (quiet_all خودش ۰۳ را تنظیم می‌کند).
// استفاده: node worker/test/run.mjs
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeSuite } from "./judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  "judge_selftest.mjs", // آزمون منفی خود runner: خروجی بد باید شکست بخورد
  "webhook_v2.mjs", // صف webhook، lease، effects، مهاجرت (SQLite محلی)
  "batch_approval.mjs", // دسته‌های اسکرپ: ادامه، CAS، عکس، image-only تلگرام و متن کوتاه
  "scrape_mode.mjs", // پنل حالت ارسال: تأیید دستی / خودکار / توقف، تغییر حالت و استقرار
  "flood_guard.mjs", // محافظ سیل و حالت آزمایشی
  "dm_menu.mjs", // منوی پیوی
  "group_moved.mjs", // پیام انتقال گروه
  "group_guidance.mjs", // راهنمای گروه
  "quiet_all.mjs", // ساعت سکوت: گروه ساکت، پیوی فعال
  "backup_coverage.mjs", // پشتیبان: همه‌ی جدول‌های ماندگار schema پوشش داده شده‌اند
  "phase2_guards.mjs", // ایرادهای قدیمی فاز ۲: retry ویزارد، دکمه‌ی قدیمی ویزارد، شمارنده‌ی کلیک DM
  "phase1_guards.mjs", // ایرادهای قدیمی فاز ۱: یادآوری در ساعت سکوت، سطح دسترسی تأیید مترو
  "reminder_approval.mjs", // یادآوری رویداد: پرسش از مالک، ۰۶:۳۰، ۷ روز قبل میان‌ترم، دیر ثبت‌شده‌ها
  "wizard_cancel.mjs", // دکمه‌ی لغوِ ویزارد: جلسه‌ی تمام‌شده «دیگه فعال نیست» می‌گوید
  "event_list_kind.mjs", // لیست رویدادهای ادمین: نوع رویداد تکراری نشان داده نمی‌شه
  "parity_tomorrow.mjs", // «فردا هفته فرد؟»: هفته‌ای که فردا در آنه؛ جمعه‌شب هفته‌ی بعد
  "parity_announce.mjs", // اعلام جمعه‌شب: هفته‌ی آینده زوج/فرد، ۲۳:۳۰ تهران، یک بار برای هر هفته
  "parity_question_words.mjs", // پرسش زوج/فرد با کلمه‌های حاشیه‌ای و «زوجیم»
  "group_answer_note.mjs", // پاسخ تکراری /week و پرسش: واکنش 👀 و یادآوری «جواب بالاست» (حداکثر یکی در ۶۰ ثانیه)
  "parity_question.mjs", // پرسش آزاد «زوج یا فرد؟» در گروه = /week
  "jozve_upload.mjs", // جزوه/کتاب/دوره/چنل: عکس، آلبوم، پیام تأیید ۱۲۰ ثانیه، منوی پیوی
  "posts_index.mjs", // ایندکس ingest: آخرین پست‌های کانال بدون خواندن کل کانال
  "bale_image_only.mjs", // اسکرپر بله: پست تصویری بدون کپشن نگه داشته می‌شود؛ بدون عکس و بدون متن کنار گذاشته می‌شود
  "bale_image_only_junk.mjs", // ورکر: پست تصویری بدون کپشن جنک نیست
  "telegram_scraper_image_only.mjs", // اسکرپر تلگرام: عکس از HTML واقعی، حذف پست بی‌متن و بی‌عکس
  "telegram_workflow.mjs", // ورک‌فلو تلگرام فقط با اجرای دستی و بدون schedule داخلی
  "d1_indexes.mjs", // ایندکس‌های کوئری‌های پرخواندن D1: بدون اسکن کامل جدول
  "metro_thursday.mjs", // مترو: پنجشنبه‌ها جدول جمعه/تعطیلی
  "deploy_workflow_policy.mjs", // deploy production دستی و با تأیید صریح
];

let failed = 0;
for (const s of SUITES) {
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    QTEST_DB: join(tmpdir(), `iaut-test-${s}.db`),
    TEHRAN_HOUR: "3",
  };
  const r = spawnSync(process.execPath, ["-r", join(here, "noon_preload.cjs"), join(here, s)], { env, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const verdict = judgeSuite(s, r.status, out);
  const passed = (out.match(/^PASS/gm) || []).length;
  console.log(`${verdict.ok ? "OK  " : "FAIL"} ${s} (PASS lines: ${passed})${verdict.ok ? "" : ` — ${verdict.reason}`}`);
  if (!verdict.ok) {
    failed += 1;
    console.log(out.split("\n").filter((l) => /^FAIL|rror|unexpected/.test(l)).slice(0, 10).join("\n"));
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
