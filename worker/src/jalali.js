// تبدیل تاریخ شمسی به میلادی (الگوریتم استاندارد) و نرمال‌سازی ورودی ادمین.

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function normalizeDigits(s) {
  return String(s || "").replace(/[۰-۹٠-٩]/g, (d) => {
    const fa = FA_DIGITS.indexOf(d);
    if (fa >= 0) return String(fa);
    return String(AR_DIGITS.indexOf(d));
  });
}

function jalaliToGregorian(jy, jm, jd) {
  const gy = jy > 979 ? 1600 : 621;
  jy -= jy > 979 ? 979 : 0;
  const days =
    365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) +
    78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy2 = gy + 400 * Math.floor(days / 146097);
  let rem = days % 146097;
  if (rem > 36524) {
    rem--;
    gy2 += 100 * Math.floor(rem / 36524);
    rem = rem % 36524;
    if (rem >= 365) rem++;
  }
  gy2 += 4 * Math.floor(rem / 1461);
  rem = rem % 1461;
  if (rem > 365) {
    gy2 += Math.floor((rem - 1) / 365);
    rem = (rem - 1) % 365;
  }
  let gd = rem + 1;
  const monthDays = [31, (gy2 % 4 === 0 && gy2 % 100 !== 0) || gy2 % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return iso(gy2, gm + 1, gd);
}

// ورودی: YYYY-MM-DD یا YYYY/MM/DD. اگه سال بین ۱۳۰۰ و ۱۶۰۰ باشه شمسیه.
// خروجی: YYYY-MM-DD میلادی یا null.
export function parseDateInput(raw) {
  const s = normalizeDigits(raw).trim().replace(/\//g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y >= 1300 && y <= 1600) {
    if (mo > 12) return null;
    return jalaliToGregorian(y, mo, d);
  }
  if (y >= 2000 && y <= 2100) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return null;
}
