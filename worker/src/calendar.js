// منطق هفته و ترم. تاریخ‌ها میلادی (YYYY-MM-DD) در D1 ذخیره می‌شن؛ نمایش شمسی با Intl.
// شمارش هفته فقط بر اساس اختلاف روز با شروع ترمه؛ تعطیلات و امتحانات روی شماره‌ی هفته اثر ندارن.

export const WEEKS = 16;
const DAY_MS = 86400000;

export function tehranToday(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
  return parts; // YYYY-MM-DD
}

const toUtc = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export const addDays = (iso, n) => {
  const d = new Date(toUtc(iso) + n * DAY_MS);
  return d.toISOString().slice(0, 10);
};

// شماره هفته (۱ تا ۱۶)، یا null اگه ترم شروع نشده یا کلاس‌ها تموم شده
export function weekIndex(startIso, todayIso) {
  const diff = Math.round((toUtc(todayIso) - toUtc(startIso)) / DAY_MS);
  if (diff < 0) return null;
  const idx = Math.floor(diff / 7) + 1;
  return idx > WEEKS ? null : idx;
}

// هفته‌ی اول فرده؛ پس شماره‌ی فرد = فرد
export const parityOf = (idx) => (idx % 2 === 1 ? "فرد" : "زوج");

export function weekRange(startIso, idx) {
  const sat = addDays(startIso, (idx - 1) * 7);
  return { from: sat, to: addDays(sat, 6) };
}

export const endOfClasses = (startIso) => addDays(startIso, WEEKS * 7 - 1);

const fa = (n) => new Intl.NumberFormat("fa-IR").format(n);

export function faDate(iso, withWeekday = true) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "UTC",
    weekday: withWeekday ? "long" : undefined,
    day: "numeric",
    month: "long",
  }).format(new Date(toUtc(iso)));
}

export const faNum = fa;

export function rangeText(startIso, idx) {
  const r = weekRange(startIso, idx);
  return `${faDate(r.from)} تا ${faDate(r.to)}`;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY_MS);
}
