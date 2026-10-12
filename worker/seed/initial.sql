-- داده‌های اولیه‌ی تأییدشده. فقط وقتی جدول خالیه وارد می‌شه (اجرای دوباره چیزی اضافه نمی‌کنه).

INSERT INTO contacts (category, name, number, note, sort_order)
SELECT * FROM (
  SELECT 'آموزش و گروه کامپیوتر', 'مدیر آموزش', '04131966408', '', 1 UNION ALL
  SELECT 'آموزش و گروه کامپیوتر', 'رئیس آموزش', '04131966407', '', 2 UNION ALL
  SELECT 'آموزش و گروه کامپیوتر', 'آموزش کامپیوتر', '04131966131', '', 3 UNION ALL
  SELECT 'آموزش و گروه کامپیوتر', 'مدیر گروه کامپیوتر', '04131966150', '', 4 UNION ALL
  SELECT 'آموزش و گروه کامپیوتر', 'مدیر گروه ارشد کامپیوتر', '04131966173', '', 5 UNION ALL
  SELECT 'آموزش و گروه کامپیوتر', 'دروس عمومی و معارف اسلامی', '04131966018', '', 6 UNION ALL
  SELECT 'امتحانات و نمرات', 'رئیس اداره امتحانات', '04131966279', '', 1 UNION ALL
  SELECT 'امتحانات و نمرات', 'مسئول ثبت نمرات', '04131966382', '', 2 UNION ALL
  SELECT 'امتحانات و نمرات', 'بایگانی امتحانات', '04131966295', '', 3 UNION ALL
  SELECT 'امور دانشجویی', 'معاونت فرهنگی و دانشجویی', '04133333472', '', 1 UNION ALL
  SELECT 'امور دانشجویی', 'امور دانشجویی', '04133327496', '', 2 UNION ALL
  SELECT 'امور دانشجویی', 'امور نقل و انتقالات', '04133330997', '', 3 UNION ALL
  SELECT 'امور دانشجویی', 'امور خوابگاه‌ها', '04131966400', '', 4 UNION ALL
  SELECT 'امور دانشجویی', 'روابط عمومی', '04131966498', '', 5 UNION ALL
  SELECT 'سربازی و معافیت', 'مسئول نظام وظیفه', '04131966399', '', 1 UNION ALL
  SELECT 'سربازی و معافیت', 'امور مشمولین و معافیت تحصیلی', '04131966397', '', 2 UNION ALL
  SELECT 'مالی و رفاهی', 'امور شهریه', '04131966518', '', 1 UNION ALL
  SELECT 'مالی و رفاهی', 'صندوق رفاه دانشجویی (وام)', '04131966363', '', 2 UNION ALL
  SELECT 'مالی و رفاهی', 'امور مالی علامه طباطبایی', '04133300074', '', 3
)
WHERE NOT EXISTS (SELECT 1 FROM contacts);

INSERT INTO resources (category, title, url, note, sort_order)
SELECT * FROM (
  SELECT 'آموزشیار', 'ورود به آموزشیار', 'https://stdn.iau.ac.ir/Student', '', 1 UNION ALL
  SELECT 'آموزشیار', 'آموزشیار (نسخه جدید)', 'https://stdn2.iau.ir/Student', '', 2 UNION ALL
  SELECT 'آموزشیار', 'آموزشیار سایر استان‌ها', 'https://eserv.iau.ir/EServices', 'فقط برای امور غیر از انتخاب واحد و حذف و اضافه', 3 UNION ALL
  SELECT 'کانال‌ها', 'کانال بله (آزمایشگاه‌ها)', 'https://ble.ir/s/iaut_fani', 'بدون نیاز به حساب بله', 1 UNION ALL
  SELECT 'کانال‌ها', 'کانال بله (مدیر گروه)', 'https://ble.ir/s/iautcom', 'بدون نیاز به حساب بله', 2 UNION ALL
  SELECT 'کانال‌ها', 'کانال خبری گروه', 'https://t.me/CEIAUT_NEWS', '', 3 UNION ALL
  SELECT 'سایر', 'جستجوی شماره‌ی کارکنان', 'https://tabriz.iau.ir/fa/employee/list?id=-', '', 1
)
WHERE NOT EXISTS (SELECT 1 FROM resources);
