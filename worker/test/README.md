# تست‌های worker

اجرا (Node 22 یا بالاتر، چون از `node:sqlite` استفاده می‌شه):

```bash
node worker/test/run.mjs
```

- همه‌ی تست‌ها با SQLite محلی و شبیه‌ساز تلگرام اجرا می‌شن. هیچ درخواستی به Telegram، Cloudflare یا production نمی‌رود.
- ساعت روی ۱۲:۰۰ تهران ثابت است (`noon_preload.cjs`). تست `quiet_all` ساعت ۰۳ را خودش تنظیم می‌کند.
- توکن و شناسه‌ها placeholder هستند؛ داده‌ی واقعی در این تست‌ها نیست.
- `batch_approval.mjs` شامل بازتولید و رفع گیرکردن دسته در `sending` (بخش Z)، نتیجه‌ی مبهم و حفظ آن، و ثبت نتیجه‌ی موفق است.

تست D1 محلی (wrangler) جدا است و با `wrangler d1 execute --local --file=worker/schema.sql` روی دیتابیس محلی اجرا می‌شه. تست آنلاین (Cloudflare staging یا production) در این مجموعه نیست.
