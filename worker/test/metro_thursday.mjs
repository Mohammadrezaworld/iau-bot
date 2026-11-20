// مترو: پنجشنبه‌ها مثل جمعه از جدول «جمعه و تعطیلی» استفاده می‌کنند؛ شنبه تا چهارشنبه جدول عادی
import { fileURLToPath as __ftp } from "node:url";
const WORKER = __ftp(new URL("..", import.meta.url));
const { usesFridayTable } = await import(WORKER + "src/metro.js");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

ok("Thursday uses the Friday/holiday table", usesFridayTable("Thu") === true);
ok("Friday uses the Friday/holiday table", usesFridayTable("Fri") === true);
for (const d of ["Sat", "Sun", "Mon", "Tue", "Wed"]) ok(`${d} uses the regular table`, usesFridayTable(d) === false);
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
