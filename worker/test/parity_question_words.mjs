// پرسش زوج/فرد با کلمه‌های حاشیه‌ای و شکل‌های «زوجیم/فردیم» (گزارش: «دوستان هفته زوجیم یا فرد؟» جواب نگرفت)
import { isParityQuestion } from "../src/public.js";
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const yes = ["دوستان هفته زوجیم یا فرد؟", "هفته زوجیم یا فرد؟", "بچه ها این هفته زوج یا فرد؟", "بچه‌ها این هفته زوج یا فرد؟", "سلام دوستان زوج یا فرد؟", "خب این هفته فردیم یا زوج؟"];
const no = ["دوستان زوجیم یا فرد کلاس داریم؟", "سلام بچه‌ها", "این هفته کلاس داریم یا نه؟", "زوج؟", "دوستان هفته زوجیم خوبه", "سلام زوج"];
ok("colloquial and filler-word questions are recognised", yes.every((t) => isParityQuestion(t)));
ok("non-questions and unrelated sentences are not", no.every((t) => !isParityQuestion(t)));
console.log(fails ? `FAILED ${fails}` : "ALL PASSED"); process.exit(fails ? 1 : 0);
